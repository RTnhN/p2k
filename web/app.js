import { Link } from './ble.js';
import { Keyboard } from './keyboard.js';
import { Touchpad } from './touchpad.js';
import { LED } from './keymap.js';
import { History } from './history.js';

const $ = (id) => document.getElementById(id);

// --- Settings (per-browser convenience; safe if storage is unavailable) ------

const DEFAULTS = { sensitivity: 1.4, scrollSpeed: 1, naturalScroll: true, doubleSpacePeriod: true, showHistory: true };
const settings = { ...DEFAULTS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('b2k-settings') || '{}'));
} catch {}
const saveSettings = () => {
  try {
    localStorage.setItem('b2k-settings', JSON.stringify(settings));
  } catch {}
};

$('sensitivity').value = settings.sensitivity;
$('scroll-speed').value = settings.scrollSpeed;
$('natural-scroll').checked = settings.naturalScroll;
$('sensitivity').addEventListener('input', (e) => { settings.sensitivity = +e.target.value; saveSettings(); });
$('scroll-speed').addEventListener('input', (e) => { settings.scrollSpeed = +e.target.value; saveSettings(); });
$('natural-scroll').addEventListener('change', (e) => { settings.naturalScroll = e.target.checked; saveSettings(); });

$('settings-toggle').addEventListener('click', () => {
  const open = $('settings').hidden;
  $('settings').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', open);
});

$('fn-toggle').addEventListener('click', () => {
  const open = $('fn-row').hidden;
  $('fn-row').hidden = !open;
  $('fn-toggle').setAttribute('aria-expanded', open);
  $('fn-toggle').classList.toggle('lock', open);
});

// --- Link --------------------------------------------------------------------

const link = new Link();
const keyboard = new Keyboard(link, { textarea: $('typing'), bar: $('keybar') });
keyboard.doubleSpacePeriod = settings.doubleSpacePeriod;
$('double-space').checked = settings.doubleSpacePeriod;
$('double-space').addEventListener('change', (e) => {
  settings.doubleSpacePeriod = keyboard.doubleSpacePeriod = e.target.checked;
  saveSettings();
});

const history = new History($('history'));
keyboard.onSent = (entry) => {
  if (settings.showHistory) history.add(entry);
};
const applyHistoryVisibility = () => {
  $('history').hidden = !settings.showHistory;
  if (!settings.showHistory) history.clear();
};
$('show-history').checked = settings.showHistory;
applyHistoryVisibility();
$('show-history').addEventListener('change', (e) => {
  settings.showHistory = e.target.checked;
  applyHistoryVisibility();
  saveSettings();
});
new Touchpad(link, { pad: $('pad'), buttons: $('mouse-buttons') }, settings);

const LABELS = { disconnected: 'Disconnected', connecting: 'Connecting…', connected: 'Connected' };

link.addEventListener('state', (e) => {
  const s = e.detail;
  $('status').dataset.state = s;
  $('status').textContent = LABELS[s];
  $('connect').hidden = s === 'connected';
  $('connect').disabled = s === 'connecting';
  document.body.dataset.state = s;
  if (s !== 'connected') $('caps').hidden = true;
});

link.addEventListener('error', (e) => {
  $('status').textContent = e.detail;
});

link.addEventListener('leds', (e) => {
  $('caps').hidden = !(e.detail & LED.capsLock);
});

function unsupportedReason() {
  const ua = navigator.userAgent;
  if (!window.isSecureContext) return 'Web Bluetooth needs HTTPS or localhost. Open this page over HTTPS.';
  if (/Firefox\//.test(ua)) return 'Firefox does not support Web Bluetooth. Use Chrome, Chromium or Edge.';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS browsers do not support Web Bluetooth. Use the Bluefy browser.';
  if (/Safari\//.test(ua) && !/Chrom(e|ium)\//.test(ua)) return 'Safari does not support Web Bluetooth. Use Chrome or Edge.';
  if (/Linux/.test(ua) && !/Android/.test(ua)) {
    return 'Chrome on Linux has Web Bluetooth turned off by default. Enable ' +
      'chrome://flags/#enable-experimental-web-platform-features and relaunch.';
  }
  return 'This browser does not expose Web Bluetooth. Use Chrome or Edge on desktop or Android.';
}

if (!Link.supported()) {
  $('unsupported').textContent = unsupportedReason();
  $('unsupported').hidden = false;
  $('connect').disabled = true;
}

$('connect').addEventListener('click', async () => {
  try {
    await link.connect();
  } catch (err) {
    if (err.name !== 'NotFoundError') {  // NotFoundError = chooser cancelled
      $('status').textContent = `Error: ${err.message}`;
    }
  }
});

$('disconnect').addEventListener('click', () => link.disconnect());

// Toggle the phone keyboard. pointerdown keeps focus from bouncing.
$('kbd-toggle').addEventListener('click', () => {
  if (document.activeElement === $('typing')) $('typing').blur();
  else keyboard.focus();
});

// Try a silent reconnect to the last dongle (Chrome with getDevices support).
if (Link.supported()) link.reconnectKnown().catch(() => {});
