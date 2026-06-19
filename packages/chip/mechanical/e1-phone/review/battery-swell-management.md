# E1 Phone Battery Swell Management

Status: cad_battery_swell_management_ready.

## Foam Pad

- Part: `battery_back_void_foam_pad`
- Material: PORON-style low-compression-set polyurethane foam, low-preload battery back pad
- Envelope: [60.0, 80.0, 0.18] mm
- Compression allowance: 0.18 mm

## Worst-Case Arithmetic

- Required capacity: 0.742 mm
- Managed capacity: 0.78 mm
- Margin: 0.038 mm

## Release Blockers

- Supplier battery drawing must include end-of-life swelling envelope, PCM, connector, pull-tab, and sample thickness data.
- Foam supplier must provide compression-set data at thermal aging conditions.
- Physical EVT thermal/aging/drop validation must confirm the foam does not preload the pouch or push the display.
