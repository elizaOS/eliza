# ArUco Print Markers

Generate printable 2-inch ArUco markers for external-camera-assisted localization:

```bash
cd /home/shaw/Documents/hyperscape-robot-workspace/ainex-robot-code
PYTHONPATH=. python3 -m perception.tools.generate_aruco_markers \
  --output-dir ../printables/aruco \
  --dictionary DICT_6X6_250 \
  --ids 0,1,2,3,4,5 \
  --size-in 2.0 \
  --dpi 300
```

Artifacts written:

- `aruco_00.png`, `aruco_01.png`, ...
- `aruco_print_sheet.html`
- `manifest.json`

Printing guidance:

- Open `aruco_print_sheet.html` in a browser.
- Print at `100%` scale.
- Do not enable "fit to page".
- Use plain white paper or matte card stock when possible.
- Measure one printed marker edge and confirm it is exactly `2.0 in`.
