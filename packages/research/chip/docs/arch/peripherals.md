# External peripheral interface scaffold

This file records product-level external interfaces that are outside the current e1 RTL but must be tracked while padframe, package, and board contracts mature.

| Interface | Contract source | Current e1 chip status |
| --- | --- | --- |
| Debug/MMIO demo bridge | `package/e1-demo-pinout.yaml` | Bonded in placeholder QFN64 package |
| GPIO LEDs/test outputs | `package/e1-demo-pinout.yaml` | Bonded in placeholder QFN64 package |
| JTAG/test reservation | `package/e1-demo-pinout.yaml` | Reserved pins only |
| WiFi/Bluetooth module | `package/wifi-external-interface.yaml` | Product scaffold; not bonded in e1 chip; SDIO host, Bluetooth transport ownership, and firmware driver absent |

Future RTL must not silently consume package pins for product interfaces. Additions should first update the machine-readable package or interface contract, then update padframe and board checks.
