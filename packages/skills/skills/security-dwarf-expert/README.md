# DWARF Expert

Interact with and analyze DWARF debug files, understand the DWARF debug format/standard, and write code that parses DWARF data.

**Author:** Evan Hellman

## When to Use

Use this skill when you need to:
- Understand or parse DWARF debug information from compiled binaries
- Answer questions about the DWARF standard (v3, v4, v5)
- Write or review code that interacts with DWARF data
- Use `dwarfdump` or `readelf` to extract debug information
- Verify DWARF data integrity using `llvm-dwarfdump --verify`
- Work with DWARF parsing libraries (libdwarf, pyelftools, gimli, etc.)

## What It Does

This skill provides expertise on:
- DWARF standards (v3-v5) via web search and authoritative source references
- Parsing DWARF files using `dwarfdump` and `readelf` commands
- Verification workflows using `llvm-dwarfdump --verify` and `--statistics`
- Library recommendations for DWARF parsing in C/C++, Python, Rust, Go, and .NET
- DIE (Debug Information Entry) analysis and searching
- Understanding DWARF sections, attributes, and forms

## Authoritative Sources

This skill uses the following authoritative sources for DWARF standard information:
- **dwarfstd.org**: Official DWARF specification (via web search)
- **LLVM source**: `llvm/lib/DebugInfo/DWARF/` for reference implementations
- **libdwarf source**: github.com/davea42/libdwarf-code for C implementations

## Installation

```
/plugin install trailofbits/skills/plugins/dwarf-expert
```
