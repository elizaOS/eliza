# E1 Phone Supplier Lock Matrix

Status: shortlist for CAD lock, not a purchase order.

## display_lcm_ctp

- Role: `screen`
- Candidate: Chenghao CH550FH01A-CT class 5.5 inch MIPI LCD + CTP
- Source: https://www.chenghaolcd.com/doc/26717023/5-5-inch-ltps-tft-lcd-module-1080-1920-resolution-mipi-lcd-screen.pdf
- Lock state: needs vendor drawing and sample quote
- Mechanical lock: `{"active_area_mm": [68.04, 120.96], "cover_glass_mm": [77.1, 151.77, 0.7], "fpc_bend_radius_mm": 1.0, "fpc_connector_mm": [19.0, 3.2, 1.15], "tft_outline_mm": [70.78, 129.17, 1.7]}`

## usb_c

- Role: `usb`
- Candidate: GCT USB4105 USB2 Type-C receptacle, reinforced shell
- Source: https://gct.co/files/specs/usb4105-spec.pdf
- Distributor: https://www.digikey.com/en/products/detail/gct/USB4105-GF-A/11198510
- Lock state: candidate active; needs exact selected suffix and footprint
- Mechanical lock: `{"envelope_mm": [8.94, 7.8, 3.25], "insertion_keepout_mm": [12.5, 10.5, 5.0], "mating_cycles": 20000}`

## side_buttons

- Role: `power_volume_buttons`
- Candidate: XKB TS-1187A-B-A-B side-push tactile switch, 3.5x2.9x1.7 mm
- Source: https://www.lcsc.com/product-detail/Tactile-Switches_XKB-Connection-TS-1187A-B-A-B_C318884.html
- Lock state: needs exact Panasonic part number and flex/direct-PCB decision
- Mechanical lock: `{"cap_power_mm": [2.0, 12.0, 1.1], "cap_volume_mm": [2.0, 21.0, 1.1], "power_force_n": 1.57, "travel_mm": 0.2, "volume_force_n": 1.57}`

## cellular_redcap

- Role: `radio`
- Candidate: Quectel RG255C RedCap LGA module
- Source: https://www.quectel.com/product/5g-redcap-rg255c-series/
- Lock state: reserved for PCB/RF planning; not yet modeled as final phone antenna system
- Mechanical lock: `{"envelope_mm": [29.0, 32.0, 2.4], "mass_g": 5.2}`

## wifi_bt

- Role: `radio`
- Candidate: Murata Type 2EA Wi-Fi 6E + Bluetooth module
- Source: https://www.murata.com/en-us/products/connectivitymodule/wi-fi-bluetooth/overview/lineup/type2ea
- Lock state: module candidate only; antenna and coax/feed geometry remain open

## rear_camera

- Role: `camera`
- Candidate: single OV13855/OV13850 class 13 MP simple-AF MIPI module, single lens, buried under flush back wall
- Source: https://sincerefirst.en.made-in-china.com/product/WACpUrRYOVkc/China-Ov13855-Ov13850-CMOS-Sensor-Autofocus-13MP-Mipi-Camera-Module.html
- Lock state: needs exact module drawing, FPC side, and lens stack height
- Mechanical lock: `{"lens_diameter_mm": 6.8, "module_mm": [10.0, 10.0, 5.1]}`

## front_camera

- Role: `camera`
- Candidate: single 5-8 MP fixed-focus MIPI module behind cover glass, single lens
- Source: external source pending
- Lock state: placeholder envelope; needs Shenzhen/OEM module selection after cover-glass aperture decision
- Mechanical lock: `{"lens_diameter_mm": 3.4, "module_mm": [6.5, 6.5, 3.2]}`
