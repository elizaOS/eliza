# Parsing ELF Files With readelf
`readelf` is a utility used to parse and dump ELF information from ELF files. It can be used to dump various ELF sections including DWARF sections.

## Commonly Used Options
- `readelf --help`: Display available options.
- `readelf --debug-dump [debug_section]`: Dump a particular DWARF section (e.g. `addr`, `pubnames`, etc). Can be specified multiple times to dump multiple sections.
- `readelf --dwarf-depth=N`: Do not display DIEs at depth N or greater.
- `readelf --dwarf-start=N`: Display DIE nodes starting at offset N.