// A one-line strip showing what was sent in the last few seconds, so you can
// check your typing without looking at the computer.

export class History {
  constructor(el, ttlMs = 10000) {
    this.el = el;
    this.ttl = ttlMs;
    setInterval(() => this._expire(), 250);
  }

  add({ kind, text }) {
    if (kind === 'backspace') {
      // Erase like the host would, as long as the char is still visible.
      const last = this.el.lastElementChild;
      if (last?.classList.contains('char')) {
        last.remove();
        return;
      }
      kind = 'chip';
      text = '⌫';
    }
    const span = document.createElement('span');
    span.className = kind;
    span.textContent = text;
    span.dataset.t = performance.now();
    this.el.append(span);
  }

  clear() {
    this.el.replaceChildren();
  }

  _expire() {
    const now = performance.now();
    for (const span of [...this.el.children]) {
      const age = now - Number(span.dataset.t);
      if (age > this.ttl) span.remove();
      else span.classList.toggle('fading', age > this.ttl - 3000);
    }
  }
}
