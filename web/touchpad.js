// Touchpad gestures -> mouse reports.
//
//   1 finger move          pointer
//   tap                    left click
//   2-finger tap           right click
//   3-finger tap           middle click
//   2-finger drag          scroll (vertical + horizontal)
//   tap, then touch+drag   drag with left button held (or double-click)

const TAP_MS = 220;
const TAP_SLOP = 10;        // px a finger may wander and still count as a tap
const DOUBLE_TAP_MS = 300;
const SCROLL_STEP = 18;     // px of finger travel per wheel detent

const BTN = { left: 1, right: 2, middle: 4 };

export class Touchpad {
  constructor(link, { pad, buttons }, settings) {
    this.link = link;
    this.pad = pad;
    this.settings = settings;   // { sensitivity, naturalScroll } (live object)

    this.pointers = new Map();  // id -> { x, y, sx, sy }
    this.gesture = null;        // { start, maxFingers, moved }
    this.padButtons = 0;        // buttons held by gestures (tap-drag)
    this.barButtons = 0;        // buttons held on the L/M/R bar
    this.lastTapEnd = 0;
    this.remX = 0;
    this.remY = 0;
    this.scrollX = 0;
    this.scrollY = 0;

    pad.addEventListener('pointerdown', (e) => this._down(e));
    pad.addEventListener('pointermove', (e) => this._move(e));
    pad.addEventListener('pointerup', (e) => this._up(e));
    pad.addEventListener('pointercancel', (e) => this._up(e, true));
    pad.addEventListener('contextmenu', (e) => e.preventDefault());

    for (const btn of buttons.querySelectorAll('[data-button]')) {
      const bit = BTN[btn.dataset.button];
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture?.(e.pointerId);
        btn.classList.add('active');
        this.barButtons |= bit;
        this._syncButtons();
        navigator.vibrate?.(8);
      });
      const up = () => {
        btn.classList.remove('active');
        this.barButtons &= ~bit;
        this._syncButtons();
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  _syncButtons() {
    this.link.mouseButtons(this.padButtons | this.barButtons);
  }

  _click(bit) {
    this.link.mouseButtons(this.barButtons | bit);
    this.link.mouseButtons(this.barButtons);
    navigator.vibrate?.(10);
  }

  _down(e) {
    e.preventDefault();
    this.pad.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });

    if (this.pointers.size === 1) {
      this.gesture = { start: e.timeStamp, maxFingers: 1, moved: false };
      this.remX = this.remY = this.scrollX = this.scrollY = 0;
      // Second touch shortly after a tap: hold the left button for a drag.
      if (e.timeStamp - this.lastTapEnd < DOUBLE_TAP_MS) {
        this.padButtons |= BTN.left;
        this._syncButtons();
        this.gesture.dragging = true;
      }
    } else if (this.gesture) {
      this.gesture.maxFingers = Math.max(this.gesture.maxFingers, this.pointers.size);
    }
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.gesture) return;

    // Use coalesced events for smoother, more precise tracking where supported.
    const events = e.getCoalescedEvents?.() ?? [e];
    let dx = 0, dy = 0;
    for (const ev of events) {
      dx += ev.clientX - p.x;
      dy += ev.clientY - p.y;
      p.x = ev.clientX;
      p.y = ev.clientY;
    }
    if (Math.hypot(p.x - p.sx, p.y - p.sy) > TAP_SLOP) this.gesture.moved = true;

    if (this.pointers.size === 1) {
      this._pointerMove(dx, dy, e.timeStamp);
    } else if (this.pointers.size === 2) {
      // Each finger reports separately; average them.
      this._scroll(dx / 2, dy / 2);
    }
  }

  _pointerMove(dx, dy, t) {
    const dt = Math.max(1, t - (this.lastMoveT ?? t - 16));
    this.lastMoveT = t;
    const speed = Math.hypot(dx, dy) / dt;  // px per ms
    const gain = this.settings.sensitivity * (1 + Math.min(speed, 3) * 0.6);
    this.remX += dx * gain;
    this.remY += dy * gain;
    const ix = Math.trunc(this.remX);
    const iy = Math.trunc(this.remY);
    this.remX -= ix;
    this.remY -= iy;
    if (ix || iy) this.link.mouseMove(ix, iy);
  }

  _scroll(dx, dy) {
    const dir = this.settings.naturalScroll ? 1 : -1;
    this.scrollX += dx;
    this.scrollY += dy;
    const step = SCROLL_STEP / this.settings.scrollSpeed;
    const w = Math.trunc(this.scrollY / step);
    const h = Math.trunc(this.scrollX / step);
    this.scrollY -= w * step;
    this.scrollX -= h * step;
    // HID wheel: + is up. Natural scrolling: content follows the finger.
    if (w || h) this.link.mouseScroll(w * dir, -h * dir);
  }

  _up(e, cancelled = false) {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size > 0 || !this.gesture) return;

    const g = this.gesture;
    this.gesture = null;
    this.lastMoveT = undefined;
    const isTap = !cancelled && !g.moved && e.timeStamp - g.start < TAP_MS;

    if (g.dragging) {
      this.padButtons &= ~BTN.left;
      this._syncButtons();
      this.lastTapEnd = 0;
      return;
    }
    if (!isTap) return;

    if (g.maxFingers === 1) {
      this._click(BTN.left);
      this.lastTapEnd = e.timeStamp;
    } else if (g.maxFingers === 2) {
      this._click(BTN.right);
    } else {
      this._click(BTN.middle);
    }
  }
}
