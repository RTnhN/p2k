#!/usr/bin/env bash
# Build the dongle firmware and produce:
#   build/browser2keyboard.uf2        app only (normal updates)
#   build/browser2keyboard-sd.uf2     app + S140 SoftDevice, for a dongle whose
#                                     SoftDevice was erased (INFO_UF2.TXT says
#                                     "SoftDevice: not found")
#
# Requires arduino-cli with the Adafruit nRF52 core:
#   arduino-cli config add board_manager.additional_urls \
#     https://adafruit.github.io/arduino-board-index/package_adafruit_index.json
#   arduino-cli core update-index && arduino-cli core install adafruit:nrf52
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
sketch="$here/browser2keyboard"
out="$here/build"
fqbn="adafruit:nrf52:mdbt50qrx"

arduino-cli compile --fqbn "$fqbn" --output-dir "$out" --warnings default "$sketch"

core_dir="$(arduino-cli config get directories.data)/packages/adafruit/hardware/nrf52"
core="$(ls -d "$core_dir"/*/ | sort -V | tail -1)"
uf2conv="$core/tools/uf2conv/uf2conv.py"
sd_hex="$(ls "$core"/bootloader/raytac_mdbt50q_rx/*_s140_6.1.1.hex | tail -1)"

python3 "$uf2conv" -f 0xADA52840 -c -o "$out/browser2keyboard.uf2" "$out/browser2keyboard.ino.hex"

python3 "$here/merge_softdevice.py" "$sd_hex" "$out/browser2keyboard.ino.hex" "$out/with-sd.hex"
python3 "$uf2conv" -f 0xADA52840 -c -o "$out/browser2keyboard-sd.uf2" "$out/with-sd.hex"

echo "UF2: $out/browser2keyboard.uf2"
echo "UF2 (with SoftDevice): $out/browser2keyboard-sd.uf2"
