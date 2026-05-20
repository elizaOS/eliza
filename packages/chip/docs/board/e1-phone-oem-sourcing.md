# E1 Phone OEM Sourcing Baseline

Status: sourcing shortlist, not a purchase order or fabrication release.
Date: 2026-05-20.

## Mechanical Anchor

Use a commodity 5.5 inch FHD MIPI display module as the first enclosure and
board-size anchor. This is a deliberate manufacturability trade: a 5.5 inch
1080 x 1920 LCM is older than current flagship phone panels, but it is widely
listed by OEM display vendors and has enough public dimensional consistency to
drive a first PCB/enclosure pass.

Target geometry:

- Active area: 68.04 x 120.96 mm.
- TFT outline target: about 70-71 x 129 mm.
- Touch/lens assembly target: about 77 x 152 x 3.4 mm.
- Device envelope target: 72 x 148 x 9.5 mm before final cover-glass and
  gasket tolerance stack.
- Rigid PCB bounding box target: 64 x 132 mm, with battery window.

The board is intentionally narrower than the display active area so the rigid
PCB can sit behind the LCM while leaving room for side-key flex, adhesive,
antenna plastic, and enclosure rails.

## Display Candidates

| Priority | Candidate | Evidence | Design Impact |
| --- | --- | --- | --- |
| Primary | 5.5 inch 1080 x 1920 MIPI 40-pin LCD/CTP, 055WU01 class | Alibaba listing advertises MIPI 4-lane, 40-pin signal interface, 1000 nit typical brightness, and 68.04 x 120.96 mm active area. | Use 4-lane DSI connector footprint and panel-bias rails; require exact FPC pinout before schematic freeze. |
| Primary alternate | Chenghao CH550FH01A-CT | Made-in-China listing shows 5.5 inch IPS TFT+CTP, 1080 x 1920, MIPI, 77.1 x 151.77 x 3.39 mm outline, 70.78 x 129.17 x 1.7 mm TFT outline, 68.04 x 120.96 mm active area. | Best current mechanical anchor because it publishes CTP and TFT outlines. |
| Lower-z alternate | 5.5 inch AMOLED 1080 x 1920 RM67191 class | Made-in-China listing shows MIPI 4 lanes, active area 68.299 x 121.421 mm, outline 70.66 x 128.36 x 0.82 mm. | Better z-height and power potential, higher sourcing and driver risk. |

Required before schematic freeze:

- Vendor drawing with FPC exit direction, connector pitch, stiffener, bend
  radius, and cover-glass stack.
- Full pinout for DSI, touch I2C, reset, TE, backlight or AMOLED power rails,
  ESD, grounds, and no-connects.
- Panel init command sequence and Linux DRM panel-driver plan.
- Backlight LED string voltage/current or AMOLED bias requirements.
- Sample quote for at least 10 units and one alternate supplier with matching
  electrical pinout.

## Camera Candidates

| Position | Candidate | Evidence | Design Impact |
| --- | --- | --- | --- |
| Rear | OV13855/OV13850 13 MP autofocus MIPI CSI module | Made-in-China Sincere First listing shows OV13855, 13 MP, autofocus, 1/3.06 inch sensor, F/2.0, 78.4 degree view angle, MIPI, 24-pin module, 10kk/month stated capacity. | Reserve 24-30 pin camera FPC, 2-4 CSI lanes, AF VCM supply, reset, clock, and privacy/flash policy. |
| Rear alternate | AR1335 13 MP AF 4-lane MIPI module | Made-in-China listing advertises AR1335, 4208 x 3120 effective pixels, 4-lane MIPI CSI-2, autofocus. | Similar routing budget; use only if driver and lens stack are better documented. |
| Front | 5-8 MP fixed-focus MIPI CSI module | Marketplace search required after enclosure z-stack is frozen. | Keep a smaller FPC zone near display/camera connector cluster; avoid committing front-camera lens height now. |

Required before schematic freeze:

- Exact FPC pinout, connector pitch, module dimensions, lens z-height, and FOV.
- CSI lane count and lane order.
- Power rail sequencing and clock requirements.
- V4L2 subdevice or Android Camera HAL path, including OTP/calibration data.

## Wireless And Cellular

| Block | Primary | Fallback | Why |
| --- | --- | --- | --- |
| Cellular | Quectel RG255C LGA or RM255C M.2 5G RedCap | Quectel RM520N-GL M.2 | RG255C/RM255C keeps first-phone power, RF, and carrier scope smaller than full eMBB 5G. RM520N-GL is easier for socketed lab validation and high-throughput testing. |
| Wi-Fi/Bluetooth | Murata Type 2EA LBEE5XV2EA-802 | Existing Murata Type 1DX | Type 2EA gives Wi-Fi 6E 2x2 MIMO + Bluetooth 5.3 in a small shielded module. Type 1DX remains lower performance but simpler Linux SDIO/UART bring-up. |
| GNSS | Cellular-module GNSS first | Discrete GNSS/LNA if desense fails | Avoid another RF subsystem until cellular and Wi-Fi antenna layout are measured. |
| NFC | Discrete NFC controller + loop antenna | Omit on EVT0 | NFC loop geometry is enclosure-dependent; keep pads but do not route into the battery window without ME signoff. |

Required before schematic freeze:

- Cellular region SKU and supported LTE/NR bands.
- Carrier/PTCRB/GCF plan and whether modular certification covers the final
  antenna implementation.
- SIM/eSIM decision and E911/GNSS policy.
- Wi-Fi/BT antenna design, coax or printed antenna decision, coexistence plan,
  and country-code handling.

## USB-C And Side Buttons

| Block | Primary | Fallback | Why |
| --- | --- | --- | --- |
| USB-C EVT0 | GCT USB4105 USB2 Type-C receptacle | Molex 221632/217804 24-pin waterproof Type-C | GCT USB4105 simplifies routing for EVT0 while still enabling charge, USB2 data, ADB/fastboot, and PD CC handling. Molex waterproof 24-pin is the production path if USB3/waterproofing is required. |
| Power / volume buttons | Panasonic EVQ-P7/P3/9P7 side-push tactile | C&K KMR2 with enclosure plunger | Panasonic side-push parts are directly aligned with phone-edge actuation. KMR2 is compact and widely distributed but needs a plunger/mechanical conversion if mounted top-actuated. |

Required before schematic freeze:

- USB-C connector exact variant, footprint, shell-stake length, port opening,
  plug overmold clearance, and enclosure capture method.
- Whether EVT0 remains USB2-only or the SoC package bonds USB3/DP lanes.
- Side-key flex vs direct-on-mainboard decision.
- Button travel stack, external actuator geometry, and wake/recovery key
  firmware mapping.

## Sources

- Alibaba, 5.5 inch TFT LCD Display 1080x1920 MIPI 40 pins with capacitive
  touch: https://www.alibaba.com/product-detail/5-5-Inch-TFT-LCD-Display_1601425016323.html
- Made-in-China, Chenghao CH550FH01A-CT 5.5 inch 1080 x 1920 MIPI LCD+CTP:
  https://chenghaolcd.en.made-in-china.com/product/pmFUBTZDnXVH/China-LCD-Manufacturer-1080-1920-Pixels-5-5inch-Pcap-Capacitive-Touch-Display-TFT-Module.html
- Made-in-China, 5.5 inch 1080 x 1920 AMOLED MIPI RM67191 class:
  https://www.made-in-china.com/showroom/bella823/product-detailDjlmucpOAohW/China-Fet-High-Resolution-1080-1920-Mipi-Interface-5-5-Inch-Amoled-Display.html
- Made-in-China, OV13855/OV13850 13 MP autofocus MIPI camera module:
  https://sincerefirst.en.made-in-china.com/product/WACpUrRYOVkc/China-Ov13855-Ov13850-CMOS-Sensor-Autofocus-13MP-Mipi-Camera-Module.html
- Made-in-China, AR1335 13 MP autofocus 4-lane MIPI camera module:
  https://sincerefirst.en.made-in-china.com/product/dfapAuFoazVG/China-Mini-Size-Ar1335-13MP-CMOS-Sensor-Af-Camera-Module-Mipi-30pin.html
- Quectel RG255C 5G RedCap product page:
  https://www.quectel.com/product/5g-redcap-rg255c-series/
- Murata Type 2EA Wi-Fi 6E + Bluetooth module:
  https://www.murata.com/en-us/products/connectivitymodule/wi-fi-bluetooth/overview/lineup/type2ea
- u-blox JODY-W5 Wi-Fi 6 + Bluetooth module family:
  https://www.u-blox.com/en/u-blox-introduces-jody-w5
- GCT USB4105 USB Type-C receptacle specification:
  https://gct.co/files/specs/usb4105-spec.pdf
- Molex USB Type-C Port-On connector datasheet:
  https://www.molex.com/content/dam/molex/molex-dot-com/en_us/pdf/datasheets/987651-4081.pdf
- Panasonic EVQ-P7/P3/9P7 side-push tactile switches:
  https://na.industrial.panasonic.com/products/switches-encoders-interface-devices/switches/light-touch-tactile-switches/series/79247
- C&K KMR2 tactile switch family:
  https://www.ckswitches.com/products/switches/product-details/Tactile/KMR2
