# Writing, Modifying, or Reviewing Code That Interacts With DWARF Data.
You may be tasked with writing, modifying, or reviewing code that handles, parses, or otherwise interacts with DWARF data. 

## General Guidelines
- **Rely on Authoritative Sources**: For ground-truth information about DWARF sections, DIE nodes, and attributes, use web search for dwarfstd.org specifications or reference LLVM/libdwarf source code implementations.
- **Using DWARF Expertise**: Use your DWARF-specific expertise to work with code that interacts with DWARF data, but do NOT use it when working with unrelated code.

## Writing Code
- **Prefer Python for Scripting**: Prefer to use Python for simpler DWARF code (such as scripts that filter for specific DIE nodes) unless another language is specified.
- **Leverage Existing Libraries**: Prefer to use existing libraries to parse/handle DWARF data if they exist for the selected language (see `Common DWARF Libraries`).
- **Refer to Library Documentation**: If using a library, refer to it's documentation as needed (both in-code and online references if available).

## Modifying Code
- **Follow Existing Styles**: Adhere to existing code styles, formatting, naming conventions, etc wherever possible.
- **Group Changes**: Perform logically related changes together and separate out unrelated groups of changes into individual steps.
- **Describe Changes**: Clearly describe the purpose of each group of changes and what each individual change achieves to the user.
- **Advise on Complex Changes**: Suggest especially large or complex changes to the user before making them. For example, if a significant amount of code needs to be added or modified to handle a particular type of DIE node or attribute.

## Reviewing Code
- **Only Suggest Changes**: Suggest changes or advise on refactors but do NOT modify the code.
- **Consider Edge Cases**: Consider edge cases that may be unhandled, such as special DIE node types, abstract base DIE nodes, specification DIE nodes, optional attributes, etc.

# Common DWARF Libraries
There are a number of libraries that can be leveraged to parse and interact with DWARF data. Prefer to use these when writing new code (if the chosen language has a compatible library).
| Library | Language | URL | Notes |
|---------|----------|-----|-------|
| `libdwarf` | C/C++ | https://github.com/davea42/libdwarf-code | Offers a simpler, lower-level interface. Used to implement `dwarfdump`. |
| `pyelftools` | Python | https://github.com/eliben/pyelftools | Also supports parsing of ELF files in general. |
| `gimli` | Rust | https://github.com/gimli-rs/gimli | Designed for performant access to DWARF data. May require other dependencies (such as `object`) to open and parse entire DWARF files. |
| `debug/dwarf` | Go | https://github.com/golang/go/tree/master/src/debug/dwarf | Standard library built-in. |
| `LibObjectFile` | .NET | https://github.com/xoofx/LibObjectFile | Also supports interfacing with object files (ELF, PE/COFF, etc) in general. |