// Web Bluetooth link to the dongle. Mirrors firmware/browser2keyboard/protocol.h.

export const SERVICE_UUID = '4b2d0001-8c3a-4f5e-9b7a-0d2c6e1f3a50';
export const INPUT_UUID   = '4b2d0002-8c3a-4f5e-9b7a-0d2c6e1f3a50';
export const STATUS_UUID  = '4b2d0003-8c3a-4f5e-9b7a-0d2c6e1f3a50';

const PKT_KEYBOARD = 0x01;
const PKT_MOUSE    = 0x02;
const PKT_CONSUMER = 0x03;

// Safe for the default 23-byte ATT MTU. Web Bluetooth doesn't expose the
// negotiated MTU, so we don't try to use more.
const MAX_WRITE = 20;

const clamp8 = (v) => Math.max(-127, Math.min(127, v));

// Events: 'state' (detail: 'disconnected' | 'connecting' | 'connected'),
//         'leds'  (detail: host LED bitmask)
export class Link extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.input = null;
    this.state = 'disconnected';
    this.queue = [];          // ordered packets that must never be merged
    this.buttons = 0;         // mouse buttons the pending motion belongs to
    this.motion = { x: 0, y: 0, wheel: 0, pan: 0 };
    this.writing = false;
    this.wantConnected = false;
    this.retryDelay = 1000;
    this.retries = 0;
  }

  static supported() {
    return !!(navigator.bluetooth && window.isSecureContext);
  }

  // Must be called from a user gesture.
  async connect() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    this._useDevice(device);
    await this._open();
  }

  // Reconnect to a previously granted device without the chooser (Chrome).
  async reconnectKnown() {
    if (!navigator.bluetooth?.getDevices) return false;
    const devices = await navigator.bluetooth.getDevices();
    if (!devices.length) return false;
    this._useDevice(devices[0]);
    try {
      await this._open();
      return true;
    } catch {
      return false;
    }
  }

  disconnect() {
    this.wantConnected = false;
    this.device?.gatt?.disconnect();
  }

  _useDevice(device) {
    if (this.device === device) return;
    this.device = device;
    this.wantConnected = true;
    device.addEventListener('gattserverdisconnected', () => this._onDisconnect());
  }

  async _open() {
    this.wantConnected = true;
    this._setState('connecting');
    try {
      const server = await this.device.gatt.connect();
      const svc = await server.getPrimaryService(SERVICE_UUID);
      this.input = await svc.getCharacteristic(INPUT_UUID);
      const status = await svc.getCharacteristic(STATUS_UUID);
      // The characteristics require encryption: the first access triggers
      // OS-level pairing if this device isn't bonded yet.
      status.oncharacteristicvaluechanged = (e) => this._emitLeds(e.target.value);
      await status.startNotifications();
      this._emitLeds(await status.readValue());
    } catch (err) {
      this.input = null;
      this._setState('disconnected');
      throw err;
    }
    this.retryDelay = 1000;
    this.retries = 0;
    this.queue = [];
    this._resetMotion();
    this._setState('connected');
    this.releaseAll();
  }

  _onDisconnect() {
    const wasConnected = this.state === 'connected';
    this.input = null;
    this.writing = false;
    this._setState('disconnected');
    if (!this.wantConnected) return;
    // Only auto-reconnect a link that was working. A drop during connect is
    // usually a rejected pairing; retrying would just re-prompt the OS.
    if (!wasConnected && this.retries === 0) {
      this.wantConnected = false;
      this._error('Connection dropped while pairing. If this device is new, short-press the ' +
        "dongle's button (LED blinks fast) and connect again.");
      return;
    }
    if (++this.retries > 5) {
      this.wantConnected = false;
      this._error('Lost the dongle. Tap Connect to try again.');
      return;
    }
    if (this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 10000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wantConnected && this.state === 'disconnected') {
        this._open().catch(() => this._onDisconnect());
      }
    }, delay);
  }

  _setState(s) {
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: s }));
  }

  _error(message) {
    this.dispatchEvent(new CustomEvent('error', { detail: message }));
  }

  _emitLeds(view) {
    if (view && view.byteLength) this.dispatchEvent(new CustomEvent('leds', { detail: view.getUint8(0) }));
  }

  // --- HID state -----------------------------------------------------------

  keyboard(modifiers, keys = []) {
    const p = new Uint8Array(8);
    p[0] = PKT_KEYBOARD;
    p[1] = modifiers;
    keys.slice(0, 6).forEach((k, i) => (p[2 + i] = k));
    this._push(p);
  }

  consumer(usage) {
    this._push(Uint8Array.of(PKT_CONSUMER, usage & 0xff, usage >> 8));
  }

  mouseButtons(buttons) {
    if (buttons === this.buttons) return;
    // Motion before a button change is sent under the old button state.
    this._flushMotionToQueue();
    this.buttons = buttons;
    this._push(Uint8Array.of(PKT_MOUSE, buttons, 0, 0, 0, 0));
  }

  mouseMove(dx, dy) {
    this.motion.x += dx;
    this.motion.y += dy;
    this._pump();
  }

  mouseScroll(wheel, pan = 0) {
    this.motion.wheel += wheel;
    this.motion.pan += pan;
    this._pump();
  }

  releaseAll() {
    this.buttons = -1;  // force a mouse packet
    this.mouseButtons(0);
    this.keyboard(0);
    this.consumer(0);
  }

  // --- Sending ---------------------------------------------------------------

  _push(packet) {
    if (this.state !== 'connected') return;
    this.queue.push(packet);
    this._pump();
  }

  _resetMotion() {
    this.motion = { x: 0, y: 0, wheel: 0, pan: 0 };
  }

  _hasMotion() {
    const m = this.motion;
    return m.x || m.y || m.wheel || m.pan;
  }

  _takeMotion() {
    const m = this.motion;
    const take = (k) => {
      const v = clamp8(m[k]);
      m[k] -= v;
      return v & 0xff;
    };
    return Uint8Array.of(PKT_MOUSE, Math.max(this.buttons, 0),
      take('x'), take('y'), take('wheel'), take('pan'));
  }

  _flushMotionToQueue() {
    while (this._hasMotion()) this.queue.push(this._takeMotion());
  }

  // One write in flight at a time. Motion that arrives while a write is
  // pending is summed, so the send rate adapts to the BLE connection.
  async _pump() {
    if (this.writing || !this.input || this.state !== 'connected') return;
    this.writing = true;
    let parts = [];
    try {
      while (this.input && (this.queue.length || this._hasMotion())) {
        parts = [];
        let len = 0;
        while (this.queue.length && len + this.queue[0].length <= MAX_WRITE) {
          const p = this.queue.shift();
          parts.push(p);
          len += p.length;
        }
        if (this._hasMotion() && len + 6 <= MAX_WRITE) {
          parts.push(this._takeMotion());
          len += 6;
        }
        const buf = new Uint8Array(len);
        let o = 0;
        for (const p of parts) {
          buf.set(p, o);
          o += p.length;
        }
        await this.input.writeValueWithoutResponse(buf);
      }
      this.writing = false;
    } catch (err) {
      // Usually a transient "operation in progress"; put the packets back so
      // a key release is never lost, and retry shortly.
      console.warn('BLE write failed', err);
      this.writing = false;
      if (this.state === 'connected') {
        this.queue.unshift(...parts);
        setTimeout(() => this._pump(), 50);
      }
    }
  }
}
