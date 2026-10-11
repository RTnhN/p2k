// HID usage tables (USB HID Usage Tables 1.4, pages 0x07 and 0x0C).

export const MOD = {
  ctrl: 0x01, shift: 0x02, alt: 0x04, gui: 0x08,
  rctrl: 0x10, rshift: 0x20, ralt: 0x40, rgui: 0x80,
};

// KeyboardEvent.code -> modifier bit
export const CODE_TO_MOD = {
  ControlLeft: MOD.ctrl, ShiftLeft: MOD.shift, AltLeft: MOD.alt, MetaLeft: MOD.gui,
  ControlRight: MOD.rctrl, ShiftRight: MOD.rshift, AltRight: MOD.ralt, MetaRight: MOD.rgui,
  OSLeft: MOD.gui, OSRight: MOD.rgui,
};

// KeyboardEvent.code -> keyboard usage
export const CODE_TO_HID = (() => {
  const m = {};
  for (let i = 0; i < 26; i++) m['Key' + String.fromCharCode(65 + i)] = 0x04 + i;
  for (let i = 1; i <= 9; i++) m['Digit' + i] = 0x1d + i;
  m.Digit0 = 0x27;
  for (let i = 1; i <= 12; i++) m['F' + i] = 0x39 + i;
  for (let i = 13; i <= 24; i++) m['F' + i] = 0x68 + (i - 13);
  for (let i = 1; i <= 9; i++) m['Numpad' + i] = 0x58 + i;
  Object.assign(m, {
    Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
    Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31,
    IntlHash: 0x32, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36,
    Period: 0x37, Slash: 0x38, CapsLock: 0x39,
    PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49, Home: 0x4a,
    PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
    ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
    NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56,
    NumpadAdd: 0x57, NumpadEnter: 0x58, Numpad0: 0x62, NumpadDecimal: 0x63,
    IntlBackslash: 0x64, ContextMenu: 0x65, NumpadEqual: 0x67,
    IntlRo: 0x87, IntlYen: 0x89,
  });
  return m;
})();

// Character -> [usage, needsShift] for a US layout host.
export const CHAR_TO_HID = (() => {
  const m = {};
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(97 + i)] = [0x04 + i, false];
    m[String.fromCharCode(65 + i)] = [0x04 + i, true];
  }
  '1234567890'.split('').forEach((c, i) => (m[c] = [0x1e + i, false]));
  '!@#$%^&*()'.split('').forEach((c, i) => (m[c] = [0x1e + i, true]));
  const pairs = [
    ['-', '_', 0x2d], ['=', '+', 0x2e], ['[', '{', 0x2f], [']', '}', 0x30],
    ['\\', '|', 0x31], [';', ':', 0x33], ["'", '"', 0x34], ['`', '~', 0x35],
    [',', '<', 0x36], ['.', '>', 0x37], ['/', '?', 0x38],
  ];
  for (const [plain, shifted, u] of pairs) {
    m[plain] = [u, false];
    m[shifted] = [u, true];
  }
  m[' '] = [0x2c, false];
  m['\n'] = [0x28, false];
  m['\t'] = [0x2b, false];
  return m;
})();

// Typographic characters phone keyboards like to insert.
export const CHAR_FALLBACK = {
  '‘': "'", '’': "'", '“': '"', '”': '"',
  '–': '-', '—': '-', '…': '...', ' ': ' ', '\r': '',
};

// Consumer page usages
export const CONSUMER = {
  volUp: 0xe9, volDown: 0xea, mute: 0xe2, playPause: 0xcd,
  next: 0xb5, prev: 0xb6,
};

export const LED = { numLock: 0x01, capsLock: 0x02, scrollLock: 0x04 };
