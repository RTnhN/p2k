// Keyboard input: native/IME typing via a hidden textarea, an on-screen bar of
// special keys with sticky modifiers, and physical keyboards on desktop.

import { MOD, CODE_TO_MOD, CODE_TO_HID, CHAR_TO_HID, CHAR_FALLBACK } from './keymap.js';

// The textarea always holds this, so Backspace on an "empty" field still
// produces an input event on mobile keyboards.
const SENTINEL = ' ';
const MAX_BUFFER = 64;
// Typed text is kept briefly for autocorrect context, then wiped.
const BUFFER_IDLE_MS = 10000;

// How keys are shown in the typing history.
const KEY_LABELS = {
  Enter: '⏎', NumpadEnter: '⏎', Backspace: '⌫', Tab: 'Tab', Escape: 'Esc', Delete: 'Del',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  PageUp: 'PgUp', PageDown: 'PgDn', Insert: 'Ins', PrintScreen: 'PrtSc', Space: 'Space',
};
const MOD_NAMES = [[MOD.ctrl | MOD.rctrl, 'Ctrl'], [MOD.alt | MOD.ralt, 'Alt'],
  [MOD.gui | MOD.rgui, 'Win'], [MOD.shift | MOD.rshift, 'Shift']];

export class Keyboard {
  constructor(link, { textarea, bar }) {
    this.link = link;
    this.textarea = textarea;
    this.bar = bar;

    this.sticky = {};          // modifier bit -> 'once' | 'lock'
    this.physMods = 0;
    this.physKeys = new Set(); // usages held on a physical keyboard
    this.barKeys = new Set();  // usages held on the on-screen bar
    this.lastValue = SENTINEL;
    // Called with { kind: 'char' | 'chip' | 'backspace', text } for each key sent.
    this.onSent = null;
    this.doubleSpacePeriod = true;

    this._initTextarea();
    this._initBar();
    this._initPhysical();
  }

  // --- State -----------------------------------------------------------------

  stickyMods() {
    let m = 0;
    for (const [bit, state] of Object.entries(this.sticky)) if (state) m |= Number(bit);
    return m;
  }

  _send(extraMods = 0, extraKeys = []) {
    const keys = [...this.physKeys, ...this.barKeys, ...extraKeys];
    this.link.keyboard(this.physMods | this.stickyMods() | extraMods, keys);
  }

  _clearOnceMods() {
    let changed = false;
    for (const bit of Object.keys(this.sticky)) {
      if (this.sticky[bit] === 'once') {
        delete this.sticky[bit];
        changed = true;
      }
    }
    if (changed) this._renderSticky();
  }

  // Report a key press to the history, combined with the active modifiers.
  // `char` is the character it types (if any); `code` names it otherwise.
  _log(char, code, extraMods = 0) {
    if (!this.onSent) return;
    const mods = this.physMods | this.stickyMods() | extraMods;
    const shortcut = mods & ~(MOD.shift | MOD.rshift);
    if (char && !shortcut) {
      this.onSent(char === '\n' ? { kind: 'chip', text: '⏎' }
        : char === '\t' ? { kind: 'chip', text: 'Tab' }
        : { kind: 'char', text: char });
      return;
    }
    if (code === 'Backspace' && !mods) {
      this.onSent({ kind: 'backspace' });
      return;
    }
    let label = KEY_LABELS[code] ?? (char ? char.toUpperCase() : code.replace(/^(Key|Digit)/, ''));
    const names = MOD_NAMES.filter(([bits]) => mods & bits).map(([, n]) => n);
    if (names.length) label = [...names, label].join('+');
    this.onSent({ kind: 'chip', text: label });
  }

  // Press and release one key, honoring sticky modifiers.
  tap(usage, extraMods = 0, char = null, code = null) {
    this._log(char, code, extraMods);
    this._send(extraMods, [usage]);
    this._clearOnceMods();
    this._send();
  }

  typeText(text) {
    for (let ch of text) {
      ch = CHAR_FALLBACK[ch] ?? ch;
      for (const c of ch) {
        const hit = CHAR_TO_HID[c];
        if (hit) this.tap(hit[0], hit[1] ? MOD.shift : 0, c);
      }
    }
  }

  releaseAll() {
    this.physKeys.clear();
    this.barKeys.clear();
    this.physMods = 0;
    this._send();
  }

  // --- Hidden textarea (phone keyboards, IMEs, dictation, paste) -------------

  focus() {
    this.textarea.focus({ preventScroll: true });
  }

  _initTextarea() {
    const ta = this.textarea;
    ta.value = SENTINEL;

    // Diff against the previous value instead of trusting beforeinput data:
    // autocorrect, swipe typing and composition all rewrite text in place.
    // The caret is kept at the end, so a common-prefix diff is exact.
    ta.addEventListener('input', () => {
      const prev = this.lastValue;
      const next = ta.value;
      let p = 0;
      while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
      for (let i = p; i < prev.length; i++) this.tap(CODE_TO_HID.Backspace, 0, null, 'Backspace');

      let typed = next.slice(p);
      // Double space after a word -> ". " (the iOS/Android shortcut, which
      // keyboards skip in fields with autocorrect off).
      if (this.doubleSpacePeriod && p === prev.length && typed === ' ' &&
          next[p - 1] === ' ' && /[\p{L}\p{N}]/u.test(next[p - 2] ?? '')) {
        this.tap(CODE_TO_HID.Backspace, 0, null, 'Backspace');
        typed = '. ';
        ta.value = next.slice(0, p - 1) + typed;
      }
      this.typeText(typed);

      const next2 = ta.value;
      if (!next2.length || (next2.length > MAX_BUFFER && !this.composing)) {
        // Keep a little trailing context so autocorrect still works.
        ta.value = SENTINEL + next2.slice(-16).trimStart();
      }
      this.lastValue = ta.value;
      this._caretToEnd();

      clearTimeout(this.wipeTimer);
      this.wipeTimer = setTimeout(() => {
        if (this.composing) return;
        ta.value = this.lastValue = SENTINEL;
      }, BUFFER_IDLE_MS);
    });

    ta.addEventListener('compositionstart', () => (this.composing = true));
    ta.addEventListener('compositionend', () => (this.composing = false));
    ta.addEventListener('select', () => this._caretToEnd());
    ta.addEventListener('click', () => this._caretToEnd());
  }

  _caretToEnd() {
    const n = this.textarea.value.length;
    if (this.textarea.selectionStart !== n || this.textarea.selectionEnd !== n) {
      this.textarea.setSelectionRange(n, n);
    }
  }

  // --- On-screen special keys --------------------------------------------------

  _initBar() {
    // Keep the textarea (and the phone keyboard) focused while using the bar.
    this.bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    this.bar.addEventListener('mousedown', (e) => e.preventDefault());

    for (const btn of this.bar.querySelectorAll('[data-code]')) {
      const usage = CODE_TO_HID[btn.dataset.code];
      // Held for as long as the finger is down, so the host auto-repeats.
      const down = (e) => {
        e.preventDefault();
        btn.setPointerCapture?.(e.pointerId);
        btn.classList.add('active');
        this._log(null, btn.dataset.code);
        this.barKeys.add(usage);
        this._send();
        navigator.vibrate?.(8);
      };
      const up = () => {
        if (!this.barKeys.has(usage)) return;
        btn.classList.remove('active');
        this.barKeys.delete(usage);
        this._clearOnceMods();
        this._send();
      };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    }

    // Sticky modifiers: off -> once -> lock -> off
    for (const btn of this.bar.querySelectorAll('[data-mod]')) {
      const bit = MOD[btn.dataset.mod];
      btn.addEventListener('click', () => {
        const s = this.sticky[bit];
        if (!s) this.sticky[bit] = 'once';
        else if (s === 'once') this.sticky[bit] = 'lock';
        else delete this.sticky[bit];
        this._renderSticky();
        this._send();
      });
    }

    for (const btn of this.bar.querySelectorAll('[data-consumer]')) {
      const usage = Number(btn.dataset.consumer);
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.classList.add('active');
        this.onSent?.({ kind: 'chip', text: btn.textContent });
        this.link.consumer(usage);
        navigator.vibrate?.(8);
      });
      const up = () => {
        btn.classList.remove('active');
        this.link.consumer(0);
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    }
  }

  _renderSticky() {
    for (const btn of this.bar.querySelectorAll('[data-mod]')) {
      const s = this.sticky[MOD[btn.dataset.mod]];
      btn.classList.toggle('once', s === 'once');
      btn.classList.toggle('lock', s === 'lock');
    }
  }

  // --- Physical keyboard -------------------------------------------------------

  _initPhysical() {
    const isFormField = (t) =>
      t instanceof HTMLElement && t !== this.textarea && t.matches('input, select, [contenteditable]');

    window.addEventListener('keydown', (e) => {
      // Virtual keyboards report keyCode 229 / "Unidentified"; those arrive
      // through the textarea's input event instead.
      if (e.isComposing || e.keyCode === 229 || e.key === 'Unidentified') return;
      if (isFormField(e.target) || this.link.state !== 'connected') return;

      const mod = CODE_TO_MOD[e.code];
      const usage = CODE_TO_HID[e.code];
      if (!mod && !usage) return;
      e.preventDefault();
      if (mod) this.physMods |= mod;
      else {
        if (!e.repeat) this._log(e.key.length === 1 ? e.key : null, e.code);
        this.physKeys.add(usage);
      }
      this._send();
    }, true);

    window.addEventListener('keyup', (e) => {
      const mod = CODE_TO_MOD[e.code];
      const usage = CODE_TO_HID[e.code];
      if (mod && this.physMods & mod) this.physMods &= ~mod;
      else if (usage && this.physKeys.has(usage)) {
        this.physKeys.delete(usage);
        this._clearOnceMods();
      } else return;
      e.preventDefault();
      this._send();
    }, true);

    // Never leave keys held when the page loses focus.
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
  }
}
