#!/usr/bin/env python3
"""Merge the S140 SoftDevice into the app hex.

The Adafruit UF2 bootloader treats 0x1000..app_end as application space, so a
UF2 that also carries the SoftDevice restores it on a dongle where it was
erased (e.g. after flashing a Zephyr build). Usage:

    merge_softdevice.py <bootloader_s140.hex> <app.hex> <out.hex>

Only 0x1000..0x26000 (SoftDevice, minus the MBR) is taken from the first file.
"""
import sys

SD_START, SD_END = 0x1000, 0x26000


def read_hex(path):
    mem, base = {}, 0
    for line in open(path):
        line = line.strip()
        if not line.startswith(':'):
            continue
        b = bytes.fromhex(line[1:])
        n, addr, rtype, data = b[0], (b[1] << 8) | b[2], b[3], b[4:4 + b[0]]
        if rtype == 0x00:
            for i in range(n):
                mem[base + addr + i] = data[i]
        elif rtype == 0x02:
            base = ((data[0] << 8) | data[1]) << 4
        elif rtype == 0x04:
            base = ((data[0] << 8) | data[1]) << 16
        elif rtype == 0x01:
            break
    return mem


def write_hex(mem, path):
    def rec(rtype, addr, data):
        b = bytes([len(data), (addr >> 8) & 0xff, addr & 0xff, rtype]) + bytes(data)
        return ':' + (b + bytes([(-sum(b)) & 0xff])).hex().upper() + '\n'

    out, upper, addrs, i = [], None, sorted(mem), 0
    while i < len(addrs):
        start = addrs[i]
        chunk = [mem[start]]
        while (i + len(chunk) < len(addrs) and len(chunk) < 16
               and addrs[i + len(chunk)] == start + len(chunk)
               and (start + len(chunk)) & 0xffff):
            chunk.append(mem[start + len(chunk)])
        if start >> 16 != upper:
            upper = start >> 16
            out.append(rec(0x04, 0, [upper >> 8, upper & 0xff]))
        out.append(rec(0x00, start & 0xffff, chunk))
        i += len(chunk)
    out.append(':00000001FF\n')
    open(path, 'w').writelines(out)


def main():
    sd_hex, app_hex, out_hex = sys.argv[1:4]
    sd = {a: v for a, v in read_hex(sd_hex).items() if SD_START <= a < SD_END}
    if not sd:
        sys.exit('no SoftDevice data found in ' + sd_hex)
    app = read_hex(app_hex)
    if any(a < SD_END for a in app):
        sys.exit('app overlaps the SoftDevice region')
    sd.update(app)
    write_hex(sd, out_hex)


if __name__ == '__main__':
    main()
