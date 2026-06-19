# LEF/DEF And OpenDB Notes

## References

- Si2 LEF/DEF downloads: https://si2.org/lef-def-downloads/
- LEF/DEF 5.7 contest mirror: https://www.ispd.cc/contests/18/lefdefref.pdf
- OpenDB docs: https://openroad.readthedocs.io/en/latest/main/src/odb/README.html

## Use in this project

LEF/DEF is the standard bridge between AlphaChip candidates and the existing
OpenLane/OpenROAD flow:

- LEF carries technology, cell, macro, pin, obstruction, and routing layer data.
- DEF carries design floorplan, rows, tracks, components, nets, pins, blockages,
  and component placement.
- OpenDB/OpenROAD should be preferred for structured reads/writes over ad hoc
  string parsing.

## AlphaChip round-trip

```text
OpenLane/OpenROAD LEF+DEF+netlist
  -> TILOS translator / OpenDB extraction
  -> Circuit Training protobuf + initial PLC
  -> AlphaChip candidate PLC
  -> candidate DEF
  -> OpenROAD read_def/write_def sanity
  -> OpenLane validation/signoff ladder
```
