// browser2keyboard: BLE -> USB HID bridge for the Raytac MDBT50Q-RX dongle.
//
// The dongle enumerates as a USB keyboard + mouse + consumer-control device.
// A browser (see ../../web) connects over BLE and writes HID state packets
// (protocol.h), which are forwarded to the USB host.
//
// Button (P0.15):  short press -> 60 s pairing window
//                  hold 5 s    -> forget all bonded devices
// LED (P1.13):     1 Hz blink = advertising, fast blink = pairing window,
//                  solid = connected and encrypted

#include <bluefruit.h>
#include <Adafruit_TinyUSB.h>
#include <Adafruit_LittleFS.h>
#include <InternalFileSystem.h>
#include "utility/bonding.h"
#include "protocol.h"

using namespace Adafruit_LittleFS_Namespace;

#define DEVICE_NAME          "B2K Dongle"
#define PAIRING_WINDOW_MS    60000
#define CLEAR_BONDS_HOLD_MS  5000

// Debug log on the USB serial port (e.g. `screen /dev/ttyACM0`).
#define LOG(fmt, ...) Serial.printf("[%lu] " fmt "\r\n", millis(), ##__VA_ARGS__)

//--------------------------------------------------------------------+
// USB HID
//--------------------------------------------------------------------+
enum { RID_KEYBOARD = 1, RID_MOUSE, RID_CONSUMER };

uint8_t const desc_hid_report[] = {
  TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(RID_KEYBOARD)),
  TUD_HID_REPORT_DESC_MOUSE(HID_REPORT_ID(RID_MOUSE)),
  TUD_HID_REPORT_DESC_CONSUMER(HID_REPORT_ID(RID_CONSUMER)),
};

Adafruit_USBD_HID usb_hid;

volatile uint8_t host_leds = 0;
volatile bool    host_leds_dirty = false;

// Keyboard LED output report (Num/Caps/Scroll Lock) from the host.
void hid_set_report_cb(uint8_t report_id, hid_report_type_t report_type,
                       uint8_t const* buffer, uint16_t bufsize) {
  if (report_type != HID_REPORT_TYPE_OUTPUT) return;
  // Without an OUT endpoint the report ID arrives separately; with one it is
  // the first byte of the buffer.
  if (report_id == 0 && bufsize >= 2) {
    report_id = buffer[0];
    buffer++;
    bufsize--;
  }
  if (report_id != RID_KEYBOARD || bufsize < 1) return;
  host_leds = buffer[0];
  host_leds_dirty = true;
}

//--------------------------------------------------------------------+
// BLE
//--------------------------------------------------------------------+
uint8_t const uuid_service[] = B2K_UUID(0x01);
uint8_t const uuid_input[]   = B2K_UUID(0x02);
uint8_t const uuid_status[]  = B2K_UUID(0x03);

BLEDis            bledis;
BLEService        b2k_service(uuid_service);
BLECharacteristic input_chr(uuid_input);
BLECharacteristic status_chr(uuid_status);

volatile bool     link_secured = false;
volatile uint32_t pairing_until = 0;
volatile uint16_t pairing_conn = BLE_CONN_HANDLE_INVALID;  // link allowed to pair now

// New devices may only pair inside a window opened by the button (or at boot
// when nothing is bonded yet). Bonded devices reconnect at any time.
bool pairing_allowed(void) {
  return (int32_t)(pairing_until - millis()) > 0;
}

void open_pairing_window(void) {
  pairing_until = millis() + PAIRING_WINDOW_MS;
  LOG("pairing window open for %d s", PAIRING_WINDOW_MS / 1000);
}

// Drops a link and forgets any bond it just created.
void reject_link(uint16_t conn_hdl, char const* why) {
  LOG("rejecting link: %s", why);
  BLEConnection* conn = Bluefruit.Connection(conn_hdl);
  if (conn && conn->bonded()) conn->removeBondKey();
  sd_ble_gap_disconnect(conn_hdl, BLE_HCI_REMOTE_USER_TERMINATED_CONNECTION);
}

bool bonds_exist(void) {
  File dir = InternalFS.open(BOND_DIR_PRPH);
  if (!dir) return false;
  File f = dir.openNextFile();
  bool found = (bool)f;
  f.close();
  dir.close();
  return found;
}

//--------------------------------------------------------------------+
// Report queue
//
// Keyboard/consumer reports and mouse button changes go through an ordered
// queue and are never merged. Pure mouse motion is summed in an accumulator
// so the pointer keeps up even when USB polls slower than BLE delivers.
//--------------------------------------------------------------------+
QueueHandle_t     report_queue;
SemaphoreHandle_t motion_mutex;

int32_t acc_x, acc_y, acc_wheel, acc_pan;  // guarded by motion_mutex
uint8_t mouse_buttons;                      // buttons the accumulator belongs to

static int8_t take_clamped(int32_t& v) {
  int32_t c = v > 127 ? 127 : (v < -127 ? -127 : v);
  v -= c;
  return (int8_t)c;
}

static bool motion_pending(void) {
  return acc_x || acc_y || acc_wheel || acc_pan;
}

// Pops up to one int8-sized chunk of accumulated motion. Caller holds the mutex.
static Report take_motion(void) {
  Report r = { PKT_MOUSE, { mouse_buttons } };
  r.data[1] = take_clamped(acc_x);
  r.data[2] = take_clamped(acc_y);
  r.data[3] = take_clamped(acc_wheel);
  r.data[4] = take_clamped(acc_pan);
  return r;
}

static void enqueue(Report const& r) {
  // Briefly block if USB is behind; drop rather than stall BLE forever.
  xQueueSend(report_queue, &r, pdMS_TO_TICKS(20));
}

static void handle_packet(uint8_t type, uint8_t const* p) {
  if (type != PKT_MOUSE) {
    Report r = { type };
    memcpy(r.data, p, pkt_len(type) - 1);
    enqueue(r);
    return;
  }

  xSemaphoreTake(motion_mutex, portMAX_DELAY);
  if (p[0] != mouse_buttons) {
    // Seal motion that happened under the old button state so a click or
    // drag never lands at the wrong position, then queue the button change.
    while (motion_pending()) enqueue(take_motion());
    mouse_buttons = p[0];
    Report r = { PKT_MOUSE };
    memcpy(r.data, p, 5);
    enqueue(r);
  } else {
    acc_x     += (int8_t)p[1];
    acc_y     += (int8_t)p[2];
    acc_wheel += (int8_t)p[3];
    acc_pan   += (int8_t)p[4];
  }
  xSemaphoreGive(motion_mutex);
}

static void release_all(void) {
  xSemaphoreTake(motion_mutex, portMAX_DELAY);
  xQueueReset(report_queue);
  acc_x = acc_y = acc_wheel = acc_pan = 0;
  mouse_buttons = 0;
  xSemaphoreGive(motion_mutex);

  enqueue(Report{ PKT_KEYBOARD });
  enqueue(Report{ PKT_MOUSE });
  enqueue(Report{ PKT_CONSUMER });
}

static bool send_report(Report const& r) {
  switch (r.type) {
    case PKT_KEYBOARD: {
      uint8_t keys[6];
      memcpy(keys, &r.data[1], 6);
      return usb_hid.keyboardReport(RID_KEYBOARD, r.data[0], keys);
    }
    case PKT_MOUSE:
      return usb_hid.mouseReport(RID_MOUSE, r.data[0], (int8_t)r.data[1], (int8_t)r.data[2],
                                 (int8_t)r.data[3], (int8_t)r.data[4]);
    case PKT_CONSUMER:
      return usb_hid.sendReport16(RID_CONSUMER, r.data[0] | (r.data[1] << 8));
  }
  return true;
}

//--------------------------------------------------------------------+
// BLE callbacks
//--------------------------------------------------------------------+
void input_write_cb(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  (void)conn_hdl;
  (void)chr;
  uint16_t i = 0;
  while (i < len) {
    uint8_t n = pkt_len(data[i]);
    if (n == 0 || i + n > len) break;  // malformed: drop the rest
    handle_packet(data[i], &data[i + 1]);
    i += n;
  }
}

void connect_cb(uint16_t conn_hdl) {
  BLEConnection* conn = Bluefruit.Connection(conn_hdl);
  LOG("connected (bonded=%d, pairing %s)", conn->bonded(), pairing_allowed() ? "open" : "closed");
  // Don't start link procedures here: they collide with the central's own
  // encryption/PHY/data-length setup and drop the link (HCI 0x23). Centrals
  // negotiate PHY and data length themselves; the interval is asked for once
  // the link is encrypted.
}

void disconnect_cb(uint16_t conn_hdl, uint8_t reason) {
  (void)conn_hdl;
  LOG("disconnected, reason 0x%02X", reason);
  link_secured = false;
  release_all();
}

void secured_cb(uint16_t conn_hdl) {
  // Only LE Secure Connections keys are acceptable: legacy pairing keys can be
  // recovered by anyone who sniffed the pairing, exposing every keystroke.
  bond_keys_t keys;
  BLEConnection* conn = Bluefruit.Connection(conn_hdl);
  if (conn->loadBondKey(&keys) && !keys.own_enc.enc_info.lesc && !keys.peer_enc.enc_info.lesc) {
    reject_link(conn_hdl, "bond uses legacy pairing; pair again");
    return;
  }
  LOG("link encrypted");
  Bluefruit.Connection(conn_hdl)->requestConnectionParameter(12);  // 15 ms: the minimum iOS accepts
  link_secured = true;
  host_leds_dirty = true;  // push current LED state to the new client
}

void pair_complete_cb(uint16_t conn_hdl, uint8_t auth_status) {
  (void)conn_hdl;
  LOG("pairing finished, status 0x%02X", auth_status);
}

// Runs after Bluefruit's own handlers (which reply to the pairing request and
// save the bond) for every BLE event.
void ble_event_cb(ble_evt_t* evt) {
  uint16_t const conn_hdl = evt->evt.gap_evt.conn_handle;

  switch (evt->header.evt_id) {
    // A new pairing attempt (bonded devices re-encrypt without this event).
    // Drop the link before any keys are exchanged unless the window is open
    // and the peer offers LE Secure Connections.
    case BLE_GAP_EVT_SEC_PARAMS_REQUEST: {
      ble_gap_sec_params_t const* peer = &evt->evt.gap_evt.params.sec_params_request.peer_params;
      LOG("pairing request (bond=%d mitm=%d lesc=%d io=%d)", peer->bond, peer->mitm, peer->lesc,
          peer->io_caps);
      if (!pairing_allowed()) {
        reject_link(conn_hdl, "pairing window closed; press the button to pair");
      } else if (!peer->lesc) {
        reject_link(conn_hdl, "peer lacks LE Secure Connections");
      } else {
        pairing_conn = conn_hdl;
      }
      break;
    }

    // Pairing finished. Double-check before keeping the new bond.
    case BLE_GAP_EVT_AUTH_STATUS: {
      ble_gap_evt_auth_status_t const* st = &evt->evt.gap_evt.params.auth_status;
      bool const expected = conn_hdl == pairing_conn;
      pairing_conn = BLE_CONN_HANDLE_INVALID;
      if (st->auth_status != BLE_GAP_SEC_STATUS_SUCCESS) break;
      if (!expected || !st->lesc) {
        reject_link(conn_hdl, "unexpected or non-LESC pairing");
      } else {
        pairing_until = 0;  // one new device per pairing window
        LOG("paired new device");
      }
      break;
    }

    case BLE_GAP_EVT_DISCONNECTED:
      if (conn_hdl == pairing_conn) pairing_conn = BLE_CONN_HANDLE_INVALID;
      break;
  }
}

//--------------------------------------------------------------------+
// Button + LED
//--------------------------------------------------------------------+
static void led(bool on) {
  digitalWrite(LED_BUILTIN, on ? LED_STATE_ON : !LED_STATE_ON);
}

static void update_led(void) {
  uint32_t t = millis();
  if (pairing_allowed() && !link_secured) led((t / 100) & 1);
  else if (link_secured)                   led(true);
  else                                     led((t / 500) & 1);
}

static void update_button(void) {
  static uint32_t pressed_at = 0;
  static bool     cleared = false;
  bool down = digitalRead(PIN_BUTTON1) == LOW;
  uint32_t t = millis();

  if (down && pressed_at == 0) {
    pressed_at = t ? t : 1;
    cleared = false;
  } else if (down && !cleared && t - pressed_at >= CLEAR_BONDS_HOLD_MS) {
    cleared = true;
    LOG("clearing all bonds");
    Bluefruit.Periph.clearBonds();
    open_pairing_window();
    if (Bluefruit.connected()) Bluefruit.disconnect(Bluefruit.connHandle());
  } else if (!down && pressed_at != 0) {
    if (!cleared && t - pressed_at >= 30) open_pairing_window();
    pressed_at = 0;
  }
}

//--------------------------------------------------------------------+
// Setup / loop
//--------------------------------------------------------------------+
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(PIN_BUTTON1, INPUT_PULLUP);
  led(false);

  report_queue = xQueueCreate(64, sizeof(Report));
  motion_mutex = xSemaphoreCreateMutex();

  // USB
  if (!TinyUSBDevice.isInitialized()) TinyUSBDevice.begin(0);
  TinyUSBDevice.setManufacturerDescriptor("browser2keyboard");
  TinyUSBDevice.setProductDescriptor("B2K Keyboard + Mouse");
  usb_hid.setPollInterval(1);
  usb_hid.setReportDescriptor(desc_hid_report, sizeof(desc_hid_report));
  usb_hid.setStringDescriptor("B2K HID");
  usb_hid.setReportCallback(NULL, hid_set_report_cb);
  usb_hid.begin();
  if (TinyUSBDevice.mounted()) {  // re-enumerate so the HID interface appears
    TinyUSBDevice.detach();
    delay(10);
    TinyUSBDevice.attach();
  }

  Serial.begin(115200);

  // BLE
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
  Bluefruit.begin(1, 0);
  Bluefruit.setName(DEVICE_NAME);
  Bluefruit.setTxPower(4);
  Bluefruit.autoConnLed(false);
  Bluefruit.setEventCallback(ble_event_cb);
  Bluefruit.Periph.setConnInterval(12, 24);  // 15-30 ms (1.25 ms units); iOS minimum is 15
  Bluefruit.Periph.setConnectCallback(connect_cb);
  Bluefruit.Periph.setDisconnectCallback(disconnect_cb);
  Bluefruit.Security.setSecuredCallback(secured_cb);
  Bluefruit.Security.setPairCompleteCallback(pair_complete_cb);

  bool const has_bonds = bonds_exist();
  LOG("started, bonds=%d", has_bonds);
  if (!has_bonds) open_pairing_window();  // first use: no button press needed

  bledis.setManufacturer("browser2keyboard");
  bledis.setModel("Raytac MDBT50Q-RX");
  bledis.begin();

  b2k_service.begin();

  input_chr.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
  input_chr.setPermission(SECMODE_NO_ACCESS, SECMODE_ENC_NO_MITM);
  input_chr.setMaxLen(244);
  input_chr.setWriteCallback(input_write_cb);
  input_chr.begin();

  status_chr.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  status_chr.setPermission(SECMODE_ENC_NO_MITM, SECMODE_NO_ACCESS);
  status_chr.setFixedLen(1);
  status_chr.begin();
  status_chr.write8(0);

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(b2k_service);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);  // 20 ms fast, 152.5 ms slow
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);
}

void loop() {
  update_button();
  update_led();

  if (host_leds_dirty) {
    host_leds_dirty = false;
    status_chr.write8(host_leds);
    if (link_secured) status_chr.notify8(host_leds);
  }

  if (!TinyUSBDevice.mounted()) {
    delay(10);
    return;
  }

  if (TinyUSBDevice.suspended()) {
    // Input while the host sleeps wakes it (if allowed) but isn't replayed.
    static uint32_t last_wake = 0;
    bool pending = uxQueueMessagesWaiting(report_queue) || motion_pending();
    if (pending) {
      if (millis() - last_wake > 500) {
        TinyUSBDevice.remoteWakeup();
        last_wake = millis();
      }
      xSemaphoreTake(motion_mutex, portMAX_DELAY);
      xQueueReset(report_queue);
      acc_x = acc_y = acc_wheel = acc_pan = 0;
      xSemaphoreGive(motion_mutex);
    }
    delay(5);
    return;
  }

  if (!usb_hid.ready()) {
    yield();
    return;
  }

  Report r;
  if (xQueueReceive(report_queue, &r, 0) == pdTRUE) {
    send_report(r);
    return;
  }

  bool have_motion = false;
  xSemaphoreTake(motion_mutex, portMAX_DELAY);
  if (motion_pending()) {
    r = take_motion();
    have_motion = true;
  }
  xSemaphoreGive(motion_mutex);

  if (have_motion) send_report(r);
  else delay(1);
}
