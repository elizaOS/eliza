# WiFi external interface contract

The application SoC will attach to an external WiFi/Bluetooth combo module
rather than implementing RF on die. The e1 chip does not bond these pins and
does not implement the SDIO host controller, Bluetooth transport ownership, or
firmware driver. This document defines the product-facing digital contract that
later padframe and board work must preserve.

## Required interface

| Group | Direction at SoC | Signals | Purpose |
| --- | --- | --- | --- |
| SDIO | bidirectional | `WIFI_SDIO_CLK`, `WIFI_SDIO_CMD`, `WIFI_SDIO_D0..D3` | Primary WiFi data path |
| Control | output | `WIFI_EN`, `WIFI_RST_N` | Module power/reset sequencing |
| Wake/IRQ | input | `WIFI_HOST_WAKE`, `WIFI_IRQ` | Module wake and interrupt notification |
| Bluetooth UART | mixed | `BT_UART_TX`, `BT_UART_RX`, `BT_UART_CTS_N`, `BT_UART_RTS_N` | Bluetooth HCI transport |
| Bluetooth PCM/I2S | mixed | `BT_PCM_CLK`, `BT_PCM_SYNC`, `BT_PCM_DIN`, `BT_PCM_DOUT` | Optional audio transport |
| Coexistence | mixed | `WIFI_COEX_REQ`, `WIFI_COEX_GRANT`, `WIFI_COEX_PRI` | Optional cellular/Bluetooth coexistence |

## Electrical assumptions

- IO voltage is `1.8 V` unless the selected module requires level shifting.
- SDIO supports SDR25 as the first bring-up mode.
- All module-facing reset and enable pins must have safe board-level defaults.
- RF, antenna, filters, crystals, shields, and regulatory design remain board/module responsibilities.

## Current integration state

The machine-readable source for this contract is
`package/wifi-external-interface.yaml`. Its current state is a product scaffold:
the pins are not bonded in the e1 chip, the host controller is not available,
and the OS/firmware driver path is not available.

## Concrete integration slice

The first board/software slice targets a Murata Type 1DX / CYW4343W-class
external combo module shape. This is a reference integration, not a committed
BOM choice. The intent is to bind the abstract signal names to a Linux-supported
SDIO WiFi plus UART Bluetooth module family while keeping RF silicon, antenna
layout, shielding, crystals, matching, and certification at the module/board
boundary.

The module-facing details live in
`package/wifi/murata-1dx-sdio.yaml`. Linux bring-up is expected to use the
standard `brcmfmac` SDIO WiFi path and `hci_uart_bcm` Bluetooth HCI UART path
once a real SDIO host, UART, GPIO, pinctrl, clock, and interrupt controller are
available in the platform. The checked-in DTS and Buildroot fragments carry
disabled stubs so BSP work can name the intended devices without claiming that
e1-chip currently has those host peripherals.

The evidence path is machine-readable in `package/wifi/evidence-gates.yaml`.
That manifest is intentionally blocked: it records the host-controller,
board/package, Linux BSP, Android framework, firmware, and regulatory artifacts
that must exist before this repo can move beyond an interface-only claim.

Required board/software validation for this slice:

- Confirm 1.8 V SDIO signaling and board-level pulls with the selected module.
- Scope `WIFI_EN`, `WIFI_RST_N`, SDIO clock, and UART flow-control sequencing.
- Keep `WIFI_EN` and `WIFI_RST_N` low until board `VBAT` and `VDDIO_1V8`
  rails are stable, then release controls in the selected module datasheet
  order before starting SDIO clock or UART RTS/CTS.
- Enumerate SDIO function 1 and load the board-specific `brcmfmac` firmware.
- Exercise `WIFI_IRQ` or OOB wake during traffic and suspend/resume.
- Attach Bluetooth over UART with flow control enabled.
- Archive Android feature, supplicant or hostapd, `dumpsys wifi`, Bluetooth HCI,
  and CTS/VTS subset evidence before any Android WiFi/Bluetooth claim.
- Keep all product claims limited to an external Linux-supported module until
  the final BOM, layout, firmware files, and certification path are complete.

The maturity gates before any product WiFi claim are:

- Select a concrete WiFi/Bluetooth module and bind this contract to that module datasheet.
- Add an SDIO host controller and Bluetooth UART/PCM ownership in RTL or platform integration.
- Bond the required pins in the product padframe and cross-check package, board, and RTL names.
- Add firmware and OS driver bring-up tests for reset sequencing, SDIO enumeration, IRQ, and wake.
- Close the blocked evidence gates for firmware provenance, Android framework
  behavior, board power sequencing, and regulatory approval scope.

`make wifi-interface-check` validates the expected groups, voltages, directions,
reset defaults, duplicate-free signal names, integration-state disclaimers, and
maturity gates. It also validates that the WiFi/BT evidence manifest remains
blocked rather than implying implementation without host controller or module
evidence.
