// BLE wire protocol shared with web/ble.js. Keep the two in sync.
//
// Service  4b2d0001-8c3a-4f5e-9b7a-0d2c6e1f3a50
//   INPUT  4b2d0002-...  write / write-without-response, encrypted
//   STATUS 4b2d0003-...  read / notify, encrypted: 1 byte of host keyboard LEDs
//
// A single INPUT write carries one or more fixed-size packets back to back.
// Each packet is a complete HID state (not an event), so a dropped packet can
// never leave a key stuck down.
#pragma once
#include <stdint.h>

// 128-bit UUIDs in little-endian byte order, as Bluefruit expects.
#define B2K_UUID(n) { 0x50, 0x3a, 0x1f, 0x6e, 0x2c, 0x0d, 0x7a, 0x9b, \
                      0x5e, 0x4f, 0x3a, 0x8c, (n), 0x00, 0x2d, 0x4b }

enum : uint8_t {
  PKT_KEYBOARD = 0x01,  // [0x01, modifiers, k1, k2, k3, k4, k5, k6]
  PKT_MOUSE    = 0x02,  // [0x02, buttons, dx:i8, dy:i8, wheel:i8, pan:i8]
  PKT_CONSUMER = 0x03,  // [0x03, usage_lo, usage_hi]   (usage 0 = release)
};

static inline uint8_t pkt_len(uint8_t type) {
  switch (type) {
    case PKT_KEYBOARD: return 8;
    case PKT_MOUSE:    return 6;
    case PKT_CONSUMER: return 3;
    default:           return 0;
  }
}

// One decoded packet, minus its type byte. Used by the firmware's report queue
// (declared here because the Arduino preprocessor hoists prototypes above
// anything defined in the .ino).
struct Report {
  uint8_t type;
  uint8_t data[7];
};
