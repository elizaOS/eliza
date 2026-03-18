---
name: security-dwarf-expert
description: "Analyze DWARF debug information in ELF binaries for security research. Use when parsing DWARF sections, recovering type information from binaries, analyzing debug symbols, understanding binary layouts, or extracting struct definitions for reverse engineering."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# DWARF Debug Information Analysis

## When to Use

- Extracting type information, struct layouts, and function signatures from debug symbols
- Analyzing binary layout and memory organization for vulnerability research
- Recovering source-level abstractions from compiled binaries
- Understanding compiler-generated code structure
- Mapping binary addresses back to source locations
- Parsing `.debug_info`, `.debug_line`, `.debug_frame` sections

## When NOT to Use

- Source code analysis (use static analysis tools instead)
- Stripped binaries without debug info (use decompilers like Ghidra/IDA)
- Windows PDB files (different format)

## Core Tools

```bash
# Check for DWARF info
readelf --debug-dump=info binary | head -50
file binary  # Look for "with debug_info"

# Dump all DWARF sections
dwarfdump binary
objdump --dwarf=info binary

# List compilation units
dwarfdump --show-form binary | grep DW_TAG_compile_unit

# Extract type definitions
dwarfdump --name=TargetStruct binary
```

## Key DWARF Tags

| Tag | Purpose |
|-----|---------|
| `DW_TAG_compile_unit` | Source file compilation unit |
| `DW_TAG_subprogram` | Function definition |
| `DW_TAG_variable` | Variable declaration |
| `DW_TAG_structure_type` | Struct definition |
| `DW_TAG_member` | Struct field |
| `DW_TAG_formal_parameter` | Function parameter |
| `DW_TAG_base_type` | Primitive type (int, char, etc.) |
| `DW_TAG_pointer_type` | Pointer to type |
| `DW_TAG_array_type` | Array type with bounds |

## Security Applications

- **Struct padding analysis**: Identify padding bytes that may leak stack data
- **Stack frame layout**: Map local variable offsets for exploit development
- **Type confusion**: Verify type sizes and alignment across compilation units
- **Function boundary recovery**: Accurate function identification for binary analysis
- **Source-level debugging**: Map crash addresses to source locations

## Resources

- DWARF Standard — https://dwarfstd.org/
- libdwarf — https://github.com/davea42/libdwarf-code
- pyelftools — https://github.com/eliben/pyelftools
