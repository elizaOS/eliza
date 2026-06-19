# Eliza E1 v0 antenna plan

Date: 2026-05-19
Status: planning. No antenna is laid out on a board.
Claim boundary: Planning document. Promotion requires antenna routing on a
fabricated board, network-analyzer S11 captures, near-field SAR scans, and
regulatory pre-compliance evidence per FCC Part 15 / CE RED.

## Scope

v0 carries three radios:

1. Wi-Fi 5 + Bluetooth 5 (Murata Type 1DX via SDIO+UART; see
   `package/wifi/murata-1dx-sdio.yaml`).
2. GNSS (GPS L1 + GLONASS L1, single-band).
3. NFC (13.56 MHz tag/peer mode for pairing/payment scaffolding).

Wi-Fi 7, BT 6, cellular (4G/5G), and UWB are explicit non-goals for v0
(`research/mobile_platform_2026/02_analysis/wifi_bt_modem.md`, "Low confidence
recommendations" L-1, L-5).

## Antenna assignment

| Radio          | Band(s)               | Antenna type       | Location (planning)               | Feed network          | Match target              |
| -------------- | --------------------- | ------------------ | --------------------------------- | --------------------- | ------------------------- |
| Wi-Fi 2.4 GHz  | 2.400-2.4835 GHz      | PIFA, 30 mm trace  | Top-left corner of mainboard      | π-network             | < -10 dB S11              |
| Wi-Fi 5 GHz    | 5.150-5.850 GHz       | shared PIFA dual-band w/ Wi-Fi 2.4 | Top-left corner       | π-network shared        | < -8 dB S11               |
| Bluetooth 5    | 2.400-2.4835 GHz      | shared with Wi-Fi 2.4 (same PIFA)  | Top-left corner       | shared π                | < -10 dB S11              |
| GNSS L1        | 1.575 GHz             | chip antenna (e.g. Inpaq A2503CC)  | Top-right corner      | LNA pre-tuned series LC | < -10 dB S11 at 1.575 GHz |
| NFC            | 13.56 MHz             | etched 4-turn loop, 25 × 35 mm     | Back of mainboard under battery cover | 50-Ω tuned (NXP PN7150 reference) | matched per NXP AN |

## Isolation and coexistence

- **Wi-Fi 2.4 / BT coexistence**: shared antenna with Murata Type 1DX
  internal TDM coexistence engine; no additional isolation needed beyond
  the module's reference circuit.
- **Wi-Fi 2.4 / GNSS**: ≥ 100 mm physical separation between PIFA feed and
  GNSS chip antenna feed; ground-pour discontinuity along the keep-out zone
  to suppress GNSS desense from Wi-Fi 2nd harmonic.
- **NFC / digital noise**: NFC loop sits under battery and is shielded from
  AP/PMIC digital noise by the battery's nickel-plated steel can; verify
  with a real RFID reader at 5 cm reading distance.

## Test points

Each antenna feed needs a U.FL test connector for VNA captures during
bring-up. U.FL is removed before regulatory testing.

## Open questions (require human decision before board layout)

1. Single PIFA dual-band vs separate 2.4 and 5 GHz antennas.
2. NFC loop placement: top of battery vs along enclosure edge.
3. GNSS LNA: integrated into chip antenna module vs discrete (e.g. Skyworks
   SKY65809).

## Cross-references

- `package/wifi/murata-1dx-sdio.yaml`
- `docs/arch/wifi.md`
- `docs/architecture-optimization/phone-platform.md`
- `research/mobile_platform_2026/02_analysis/wifi_bt_modem.md`
