# p2k

Use a phone (or any Web Bluetooth browser) as a keyboard and touchpad for a computer, through a
Raytac MDBT50Q-RX nRF52840 USB dongle.

```
 phone / browser  ──BLE──▶  dongle  ──USB HID──▶  computer
  web/                       firmware/             sees a normal keyboard + mouse
```

The computer needs no software or Bluetooth. It sees a standard USB keyboard, mouse and media-key
device.

## Security

A device that types on your computer is a keystroke-injection tool by design, so the questions
that matter are **who can drive it** and **who can read what goes through it**. The model below answers both, and each claim points to the code that enforces it,
so you can check it yourself. Nobody has audited it independently.

### What it protects against

| Threat | Defense | Enforced in |
|---|---|---|
| A stranger in Bluetooth range connects and types on your computer | Both GATT characteristics require an encrypted, bonded link. The Nordic SoftDevice rejects reads and writes before the firmware ever sees them. | `input_chr.setPermission(...)` in `browser2keyboard.ino` |
| A stranger pairs a new phone | Pairing is accepted only during a 60 s window opened by a physical button press, or at first power-up when nothing is paired yet. Each window admits one device. Requests outside it are dropped before any keys are exchanged. | `ble_event_cb` → `BLE_GAP_EVT_SEC_PARAMS_REQUEST` |
| An eavesdropper records your keystrokes, including passwords | Only LE Secure Connections (ECDH) pairing is accepted. A passive sniffer can't derive the link key, even if it recorded the pairing. Legacy pairing is refused, and old legacy bonds are dropped on reconnect. | `ble_event_cb` (`peer->lesc`, `st->lesc`), `secured_cb` |
| A pairing slips through anyway | At pairing completion the firmware checks the link was the one it approved and used LESC. Otherwise it deletes the new bond and disconnects. | `ble_event_cb` → `BLE_GAP_EVT_AUTH_STATUS` |
| Keys stuck down after a dropped connection | Packets carry full key state, not press/release events, and the dongle releases everything on disconnect. | `release_all()` |
| Malformed or malicious packets | Fixed-size packets with length checks. Anything unparseable is dropped. | `input_write_cb`, `pkt_len()` |
| Script injection into the web page | No third-party code, no `innerHTML` or `eval`, and a strict Content Security Policy: `default-src 'none'; script-src 'self'`. | `web/index.html` |
| Typed text lingering on the phone | The hidden typing buffer is wiped after 10 s idle. The on-screen history can be turned off in ⚙. | `web/keyboard.js`, `web/app.js` |

### What it does *not* protect against

- **A paired phone is fully trusted.** It can type anything the logged-in user can: open a
  terminal, run commands. Only pair devices you control. Hold the dongle button 5 s to revoke
  every bond.
- **An active man-in-the-middle during pairing.** The dongle has no screen or keypad, so it can
  only do "Just Works" pairing, which can't authenticate the other side. The short,
  button-gated window narrows the exposure. Pair somewhere an attacker is unlikely to be actively
  waiting.
- **The website's host.** Whoever controls the origin serving the page controls what it sends
  once you connect. Use the official site (https://zachstrout.com/p2k), self-host it, or run it
  from `localhost`.
- **Physical access.** Anyone who can plug in the dongle can reflash it over UF2, as with any
  UF2 device.
- **Shoulder surfing.** The typing history shows recent text for 10 s. Turn it off before typing
  passwords.

### Checking it yourself

The dongle has a USB serial port (`screen /dev/ttyACM0 115200`) that logs every connection,
pairing request, acceptance or rejection with a reason, and disconnect. It never logs
keystrokes. Try pairing a second phone without pressing the button: the log shows
`rejecting link: pairing window closed`.

Found a problem? Please open an issue.

## Firmware (`firmware/`)

Arduino sketch on the Adafruit nRF52 core (Bluefruit BLE + TinyUSB). The core targets the
dongle directly (board `adafruit:nrf52:mdbt50qrx`).

### Build

```sh
arduino-cli config add board_manager.additional_urls \
  https://adafruit.github.io/arduino-board-index/package_adafruit_index.json
arduino-cli core update-index
arduino-cli core install adafruit:nrf52

firmware/build.sh
```

This produces two files:

| File | Use |
|---|---|
| `firmware/build/browser2keyboard.uf2` | Normal updates |
| `firmware/build/browser2keyboard-sd.uf2` | Same app plus Nordic's S140 6.1.1 SoftDevice. Use it first if the dongle's `INFO_UF2.TXT` says `SoftDevice: not found`, e.g. after it ran a Zephyr build. |

### Flash

1. Double-tap the dongle's reset button. A `MDBT50QBOOT` drive appears.
2. Copy the `.uf2` onto it. The dongle reboots as **B2K Keyboard + Mouse**.

### Dongle controls

| | |
|---|---|
| LED blinking 1 Hz | advertising, waiting for a bonded device |
| LED blinking fast | pairing window open |
| LED solid | connected and encrypted |
| Button short press | open a 60 s pairing window for a new device |
| Button hold 5 s | forget all paired devices (pairing window opens) |

A new device can only pair while the pairing window is open. The window opens when you press the
button, and also for 60 s at power-up if nothing is paired yet. Each window admits one device.
Paired devices reconnect any time without the button.

## Website (`web/`)

Static HTML/JS with no build step. Web Bluetooth needs **HTTPS or `localhost`**, and runs in
Chrome or Edge on desktop and Android. iOS Safari lacks Web Bluetooth; use the Bluefy browser.

Hosted at **https://zachstrout.com/p2k**. Every push to `main` that touches `web/` redeploys it
(`.github/workflows/pages.yml`).

```sh
python3 -m http.server -d web 8000     # http://localhost:8000
```

To use it from a phone, host `web/` somewhere with HTTPS (e.g. GitHub Pages). For an Android
phone over USB, you can instead run `adb reverse tcp:8000 tcp:8000` and open
`http://localhost:8000` on the phone.

### Controls

- **Touchpad.**
  - Move: one finger.
  - Left click: tap.
  - Right click: two-finger tap.
  - Middle click: three-finger tap.
  - Scroll: two-finger drag.
  - Drag or double-click: tap, then touch and drag.
  - L/M/R buttons can be held while you move with another finger.
- **⌨** opens the phone keyboard. Typed text, autocorrect, swipe typing and dictation are all
  forwarded. Text is converted for a **US keyboard layout** on the computer.
- **Ctrl/Alt/Shift/Win** are sticky. One tap applies to the next key, a second tap locks it, a
  third releases it.
- **Fn** shows F1–F12. Media keys control volume and playback.
- On desktop, a physical keyboard is forwarded while the page has focus. Browser-reserved
  shortcuts like Ctrl+W can't be captured.

## Protocol

One custom GATT service. Both characteristics require an encrypted (bonded) link.

| UUID | Characteristic |
|---|---|
| `4b2d0001-8c3a-4f5e-9b7a-0d2c6e1f3a50` | service |
| `4b2d0002-…` INPUT | write / write-without-response |
| `4b2d0003-…` STATUS | read / notify: host keyboard LEDs (bit 0 Num, 1 Caps, 2 Scroll) |

An INPUT write holds one or more packets back to back:

| Type | Bytes | Layout |
|---|---|---|
| `0x01` keyboard | 8 | `01 mods k1 k2 k3 k4 k5 k6` (boot keyboard report) |
| `0x02` mouse | 6 | `02 buttons dx dy wheel pan` (signed 8-bit deltas) |
| `0x03` consumer | 3 | `03 usage_lo usage_hi` (0 = release) |

Packets carry full report state, not events. A lost packet can't leave a key stuck, and the
dongle releases everything when the link drops. See `firmware/browser2keyboard/protocol.h` and
`web/ble.js`.
