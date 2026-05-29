# E1 Chip Viewer

Generate the data bundle:

```sh
make chip-viewer
```

Then serve `packages/chip/viewer/` over HTTP and open `index.html`. The viewer
is intentionally static: it renders the current logical RTL layout, NPU opcode
surface, benchmark evidence, release-gated NPU power/TOPS status, and the
Ariane/CVA6 reference floorplan from checked repository evidence.
