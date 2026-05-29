# E1 Phone Supplier STEP Sourcing Agent Report

Date: 2026-05-28

Lane: supplier/off-the-shelf part and STEP model research.

Scope: the 13 records currently blocked as `pending_supplier_pad_map_or_order_records` in `development-pad-pin-coverage-audit-2026-05-22.yaml`, plus the selected display, camera, radio, USB, battery, interconnect, audio, haptic, NFC, sensor, and power parts visible in the E1 phone KiCad/CAD intake files.

## Release Boundary

This research found useful public evidence, but it does not close release. Most commodity ICs and connectors have public datasheets and package drawings. Some have distributor or third-party EDA/STEP models. The phone-specific display, camera modules, battery pack, antennas, and flex assemblies still require signed supplier drawing packs or RFQ responses before they can be used for release.

Public marketplace listings from Alibaba, Made-in-China, Chinax, or reseller pages are sourcing signals only. They are not AVL evidence, not lifecycle statements, not signed drawings, not production quotes, and not authorization to freeze footprints.

## Findings By Pending Record

| Footprint | Candidate part or family | Public source status | STEP / CAD status | Release use |
| --- | --- | --- | --- | --- |
| `AUDIO_CODEC_QFN48_DEV` | Cirrus Logic/Wolfson WM8962 QFN class, Cirrus CS47L35 smart codec class | Public datasheets exist for codec functions and package drawings, but the repo has not selected one exact QFN48 codec MPN. | Generic package model only until exact MPN selected. | No. Select exact codec, then intake datasheet, package drawing, land pattern, EDA model, and lifecycle. |
| `BACKLIGHT_BIAS_POWER_DEV` | TI LM3697, SG Micro SGM37603, similar phone WLED boost drivers | LM3697 is active and public but is 12-ball DSBGA, not the current QFN24 placeholder. SGM37603 public product/datasheet pages exist, but package/availability must be checked against the selected variant. | Current QFN24 placeholder is not release-match for LM3697. | No. Either change footprint to selected public WLCSP/DSBGA driver or select a real QFN24 driver with manufacturer land pattern. |
| `BATTERY_4P_1P00_DEV` | Custom 1-cell Li-polymer pack with 4-pin connector | Marketplace packs exist, but pack dimensions, PCM, NTC, connector, wire/FPC order, safety docs, and lot traceability are supplier-specific. | STEP/drawing normally requires RFQ/supplier pack. | No. Needs signed battery drawing, UN38.3/MSDS/IEC62133 evidence, connector pin order, and sample inspection. |
| `CAMERA_24P_0P50_DEV` | SincereFirst SF-XR3855A-A0 / OV13855 13MP AF MIPI module | Public vendor pages and a SincereFirst module-list PDF identify SF-XR3855A-A0, 24-pin connector class, 8.5 x 8.5 x 4.72 mm module signal. | Exact module STEP, optical datum, FPC exit, lane order, and mating connector remain RFQ/signed drawing items. | No. Public module listing is not enough for FPC pinout release. |
| `CAMERA_30P_0P50_DEV` | SincereFirst GC5035 5MP MIPI module family | Public pages show GC5035 MIPI module classes and customization. Exact `SF-G5035S60FY` public drawing evidence remains weak. | Exact STEP/pinout/connector still RFQ-only. | No. Use only as sourcing seed until supplier drawing and sample are received. |
| `DISPLAY_40P_0P30_DEV` | Chenghao CH550FH01A / CH550FH01A-CT 5.5 in FHD MIPI touch display | Public Chenghao pages and PDFs confirm 5.5 in, 1080 x 1920, MIPI, outline/active area, and touch variants. One public PDF shows a 31-pin CH550FH01A, so it conflicts with the repo's 40-pin placeholder. | No release STEP or exact FPC pin assignment found publicly. | No. Must resolve exact `-CT` orderable variant, pin count, FPC drawing, connector, and STEP before freezing. |
| `FUEL_GAUGE_WLCSP_DEV` | Analog Devices MAX17055, TI BQ27426 class | MAX17055 public product page shows production status and 1ku price signal. TI BQ27426 is active but 9-ball DSBGA, not WLCSP12. | Public package drawings exist in datasheets; exact STEP may be distributor/EDA-library sourced after MPN freeze. | No. Select exact gauge and align ball count/footprint. Current WLCSP12 placeholder is not proven. |
| `HAPTIC_DRIVER_WLCSP_DEV` | TI DRV2625 9-ball DSBGA haptic driver | TI datasheet includes pin configuration and land pattern example for YFF0009-C01. | STEP likely available through TI/distributor/CAD portals, but repo should treat datasheet package drawing as primary until model is verified. | Potentially yes after exact DRV2625 MPN, datasheet revision, and land pattern are captured. |
| `NFC_CONTROLLER_QFN_DEV` | ST ST25R3916/ST25R3916B QFN32 family | ST public product pages and datasheets cover QFN32 pinout, footprint examples, CAD resources, and active status. | ST CAD resources should be used for package/3D intake when downloadable. | Potentially yes after exact ST25R3916 variant is selected and RF antenna/matching design is tuned. |
| `NFC_LOOP_MATCH_DEV` | NFC antenna matching network, 0402/0201 L/C/R plus test/tuning pads | No single off-the-shelf "loop match" part can be released without antenna tuning. | CAD is passives plus antenna/flex geometry, not a fixed STEP model. | No. Needs tuned antenna, VNA results, matching values, layout keepouts, and antenna supplier drawing. |
| `QUECTEL_RG255C_GEOMETRY_DEV` | Quectel RG255C LGA 5G RedCap | Quectel public pages/spec PDFs confirm RG255C, LGA, 204 pins, 29.0 x 32.0 x about 2.4 mm, and regional SKUs. SnapMagic advertises symbol/footprint/3D model. | Public/third-party CAD may exist, but release should use Quectel official hardware design/reference layout/STEP under the correct regional SKU pack. | No. Needs Quectel official hardware design pack, exact SKU, STEP, land pattern, RF layout notes, and certification scope. |
| `SENSOR_HUB_QFN_DEV` | Current placeholder says QFN24; public IMU candidates BMI270/LSM6DSO32 are 14-pin LGA, not QFN24 | Bosch BMI270 and ST LSM6DSO32 public pages have package dimensions, datasheets, and CAD resources, but neither matches QFN24. | Current QFN24 placeholder should be replaced or justified by a real selected QFN24 sensor hub/MCU. | No. Pick real sensor/hub IC; do not release QFN24 placeholder against LGA14 IMU sources. |
| `USIM_ESD_LEVELSHIFT_DEV` | TI TXS4555, Nexperia/NXP NVT4555/NXT4556 class SIM interface level translators | Public SIM level-shifter/supply parts exist with datasheets and package options. The repo has not selected an exact package/MPN matching the current 10-pad placeholder. | STEP/land pattern cannot be verified without exact MPN/package. | No. Select exact SIM interface protector/level shifter and intake datasheet/land pattern. |

## Selected Hardware Notes

- Display: Chenghao `CH550FH01A-CT` remains a plausible EVT display anchor, but public evidence is internally inconsistent on pin count. Do not keep the `DISPLAY_40P_0P30_DEV` release path unless the selected supplier drawing confirms 40 pins at 0.30 mm pitch.
- Rear camera: SincereFirst `SF-XR3855A-A0` has better public evidence than the front camera. The module-list PDF is useful because it lists module size, connector family, and 24-pin connector class. It still does not provide release pinout or STEP.
- Front camera: GC5035 public sourcing is viable as a camera class, but the exact `SF-G5035S60FY` evidence remains weak. Treat as RFQ-blocked.
- Cellular: Quectel RG255C has the strongest public module evidence among the blocked items, but phone release still needs the official hardware design pack, regional SKU, RF certifications, and official mechanical/land-pattern files.
- Wi-Fi/Bluetooth: Murata Type 2EA (`LBEE5XV2EA-802`) has public Murata datasheet evidence and distributor orderability. It is not one of the 13 blocked records but should be retained as a strong selected module candidate pending antenna/regulatory closure.
- USB-C: GCT `USB4105-GF-A-120` is a good off-the-shelf connector choice. Digi-Key and Mouser expose datasheet/EDA/3D model links and pricing. This part is suitable for release intake after model license and footprint dimensions are verified.
- Interconnect: Hirose BM28 has strong official source support, including 2D drawings, 3D models, and inventory. The exact circuit count and mate pair must be selected before flex routing is frozen.
- Charger/power: Analog MAX77860 is public and production with WLP package information. TI TPS65987DDH is public/orderable but may be too expensive/large if the product is USB2 charging-only. Neither should be considered closed without an exact architecture decision.
- Side buttons: Panasonic EVQ-P7/P3/9P7 is a credible side-push tactile family with public datasheets and drawings. Select exact terminal/force/boss variant before actuator geometry freeze.

## Recommended Repo Intake Paths

- Manufacturer datasheets and land-pattern PDFs: `packages/chip/board/kicad/e1-phone/production/sourcing/<family>/`
- Supplier STEP or native CAD files: `packages/chip/board/kicad/e1-phone/production/step/component-models/vendor/`
- KiCad footprint replacements: `packages/chip/board/kicad/e1-phone/e1-phone-dev.pretty/`, with source metadata linked from `footprint-3d-model-library-map.yaml`
- Signed display/camera/battery/interconnect drawing packs: `packages/chip/board/kicad/e1-phone/production/sourcing/<family>/signed-2d-drawing.pdf`
- Machine-readable pinout/pad-map CSVs: `packages/chip/board/kicad/e1-phone/production/sourcing/<family>/pinout-or-pad-map.csv`
- Release decision trail: `packages/chip/board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml`

## External Sources Checked

- Quectel RG255C product page and public specification PDFs: `https://www.quectel.com.cn/product/5g-rg255c-series`, `https://www.quectel.com/content/uploads/2024/03/Quectel_RG255C_Series_5G_Module_Specification_V1.0.0_Preliminary_20240411.pdf?wpId=114147`
- SnapMagic RG255C CAD listing: `https://www.snapeda.com/parts/RG255C/Quectel/view-part/`
- Murata Type 2EA: `https://www.murata.com/products/connectivitymodule/wi-fi-bluetooth/overview/lineup/type2ea`, `https://www.murata.com/products/productdata/8821679357982/type2ea.pdf`
- Hirose BM28: `https://www.hirose.com/product/series/BM28?lang=en`, `https://info.hirose.com/products/bm28`
- GCT USB4105-GF-A-120: `https://www.digikey.com/en/products/detail/gct/USB4105-GF-A-120/14559037`, `https://www.mouser.com/ProductDetail/GCT/USB4105-GF-A-120`, `https://gct.co/files/specs/usb4105-spec.pdf`
- Chenghao CH550FH01A: `https://www.chenghaolcd.com/sale-26717023-5-5-inch-ltps-tft-lcd-module-1080-1920-resolution-mipi-lcd-screen.html`, `https://www.chenghaolcd.com/doc/26717023/5-5-inch-ltps-tft-lcd-module-1080-1920-resolution-mipi-lcd-screen.pdf`, `https://www.chenghaolcd.com/doc/14278607/5-5-inch-small-lcd-display-screens-with-4-lane-mipi-interface.pdf`
- SincereFirst OV13855/GC5035: `https://www.sincerefirst.com/sincerefirst-solution/6009.html`, `https://sincerefirst.en.made-in-china.com/product/ZYhRSQCxZMVc/China-Human-Tracking-4K-30fps-Image-Sensor-Ov13855-CMOS-13MP-Ai-Embedded-Camera-Module-for-Android.html`, `https://www.cameramodule.com/fpc-camera-module/auto-focus-camera-module/ov13855-camera-sensor-module-high-resolution.html`, `https://www.asmec.co.jp/file.upload/images/Gid1993Pdf_SINCERE%20FIRST%20FPC%20Camera%20Module%20List%28%E7%9B%AE%E5%BD%95%29_2024-03-27.pdf`
- TI LM3697, BQ27426, DRV2625: `https://www.ti.com/product/LM3697/part-details/LM3697YFQR`, `https://www.ti.com/product/BQ27426`, `https://www.ti.com/lit/ds/symlink/drv2625.pdf`
- Analog MAX17055, MAX77860/MAX77960: `https://www.analog.com/en/products/max17055.html`, `https://www.analog.com/en/products/online-datasheet/max77860.html`, `https://www.analog.com/en/products/max77960.html`
- ST ST25R3916, LSM6DSO32: `https://www.st.com/en/nfc/st25r3916.html`, `https://www.st.com/resource/en/datasheet/st25r3916.pdf`, `https://www.st.com/en/product/lsm6dso32`
- Bosch BMI270: `https://www.bosch-sensortec.com/products/motion-sensors/imus/bmi270/`, `https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmi270-ds000.pdf`
- SIM interface level-shift/protection candidates: `https://www.ti.com/product/TXS4555/part-details/TXS4555RUTR`, `https://www.ti.com/lit/ds/symlink/txs4555.pdf`, `https://www.nxp.com/docs/en/data-sheet/NVT4555.pdf`, `https://www.nexperia.com/products/analog-logic-ics/voltage-translators-level-shifters`
- Panasonic EVQ-P7/P3/9P7: `https://na.industrial.panasonic.com/products/switches-encoders-interface-devices/switches/light-touch-tactile-switches/series/79247`, `https://industrial.panasonic.com/cdbs/www-data/pdf/ATK0000/ATK0000C378.pdf`

## Next Actions

1. Replace placeholder records that conflict with public packages: backlight QFN24 versus LM3697 DSBGA12, sensor-hub QFN24 versus BMI270/LSM6DSO32 LGA14, and any fuel-gauge WLCSP12 assumption unless a real WLCSP12 part is selected.
2. Send RFQs for display, rear camera, front camera, battery, and flex/interconnect packs requesting signed 2D drawing, STEP, FPC pinout, mating connector MPN, lifecycle, MOQ, price breaks, compliance, and sample lot tracking.
3. Intake official or distributor CAD for GCT USB4105, Hirose BM28, ST25R3916, Murata Type 2EA, TI DRV2625, and selected charger/fuel-gauge parts after checking license terms.
4. Keep all 13 pending records `release_allowed: false` until exact MPN, supplier drawing, land pattern, pinout, STEP, and sample evidence are committed.
