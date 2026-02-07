# Parsing DWARF Files With dwarfdump
`dwarfdump` is a utility used to parse and dump DWARF information from DWARF files. It can be used to dump individual DWARF sections, display DIE node trees (both parents and children), search for DIE nodes by name or address, and verify that DWARF files are well-formed.

## dwarfdump vs llvm-dwarfdump
Two slightly different flavors of the `dwarfdump` utility exist:
- libdwarf's implementation, typically called `dwarfdump`
- LLVM's implementation, typically called `llvm-dwarfdump`

Both can be used interchangeably, albeit with slightly different command-line options. Both accept options to modify the dumped output and the path to the object file containing the DWARF information to dump. The actual `dwarfdump` command my refer to either of the utilities depending on the system; Use `dwarfdump --version` to determine which implementation is used.

## Commonly Used Options for LLVM dwarfdump
These options are specific to LLVM's implementation of `dwarfdump`.
- `dwarfdump --version`: Display version information. Use to determine whether the system uses libdwarf's or LLVM's implementation.
- `dwarfdump --help`: Display available options.
- `dwarfdump --all`: Dump all DWARF sections.
- `dwarfdump --<debug_section>`: Dump a particular DWARF section (e.g. `--debug-addr`, `--debug-names`, etc). Can be specified multiple times to dump multiple sections.
- `dwarfdump --show-children [--recurse-depth=<n>]`: Show a debug info entry's children when selectively printing entries. Optionally, provide `--recurse-depth` to limit the depth of children to diplay. Use in cases where information about parent DIE nodes is especially relevant or requested. Commonly used when displaying DIE nodes for functions and data types as child DIE nodes contain info about parameters, local variables, structure members, etc.
- `dwarfdump --show-parents [--parent-recurse-depth=<n>]`: Show a debug info entry's parents when selectively printing entries. Optionally provide `--parent-recurse-depth` to limit the depth of parents to display. Use in cases where information about parent DIE nodes is especially relevant or requested.
- `dwarfdump --show-form`: Show DWARF form types after the DWARF attribute types. Use to display more verbose DWARF information about the type of DWARF attributes.
- `dwarfdump --find=<pattern>`: Search for an exact match of the given name in the accelerator tables. This will not perform an exhaustive search over all DIE node. Use as an initial lookup for DIE nodes with specific names, but fall back to using `--name <pattern>` to perform an exhaustive search if `find` does not find any DIE nodes with the given name.
- `dwarfdump --name <pattern> [--ignore-case] [--regex]`: Search for any DIE nodes whose name matches the given pattern. Optionally use `--ignore-case` to perform a case-insensitive search and/or `--regex` to interpret the pattern as a regex for more complex searches. Performs an exhaustive search over all DIE nodes. Use to perform exhaustive lookup for exact name matches where `--find=<pattern>` fails or to search for more complex name via regex.
- `dwarfdump --lookup=<address>`: Find the DIE node at a specific address. Use to search for specific DIE nodes when their address is known, such as when gathering information about a DIE node referenced by some previously dumped DIE node.
- `dwarfdump --verify`: Verify a DWARF file. Use to check whether a DWARF file is well-formed.
- `dwarfdump --verbose`: Print more low-level encoding details. Use in cases where extra information is helpful for debugging.

## Verification Options (llvm-dwarfdump)
These options are useful for validating DWARF data integrity:
- `llvm-dwarfdump --verify <binary>`: Verify DWARF structure including compile unit chains, DIE relationships, and address ranges.
- `llvm-dwarfdump --verify --error-display=<mode>`: Control verification output detail. Modes: `quiet` (errors only), `summary`, `details`, `full` (errors with summary).
- `llvm-dwarfdump --verify --verify-json=<path>`: Output JSON-formatted error summary to file. Useful for CI integration.
- `llvm-dwarfdump --statistics <binary>`: Output debug info quality metrics as single-line JSON. Useful for comparing builds.
- `llvm-dwarfdump --verify --quiet`: Run verification without output to stdout (exit code indicates success/failure).

## Searching DIE Nodes
In many cases it is necessary to search for specific DIE nodes (and their children and/or parents).

### Simple Search
For simple cases such as name matches or exact address matches, prefer using `dwarfdump` with `--lookup`, `--find`, or `--name`.

### Complex Search
In more complex cases cases, it may be necessary to perform custom searching over the output. For example, finding all DWARF parameter DIE nodes that have a particular type necessitates manually searching the `dwarfdump` output. In cases such a these, follow these steps:
| Step | Description | Example |
|------|-------------|---------|
| Initial Filtering | Dump the entire DWARF file and use filtering tools, such as `grep`, to perform more complex filtering of the data. | `dwarfdump <file> \| grep "float \*"` to search for the `float *` type. |
| Get DIE Address |  Get the address of any DIE node that match the search. This may require refinining the previous command to print more than just the matching line, such as using the `grep -B <n>` option to print `n` lines before the matching one to get the line with the address. | `dwarfdump <file> \| grep -B 5 "float \*"` to print 5 preceding lines for each match. This will print the line with the DIE node type and address. |
| Refine Filtering | Additional filtering may be required to narrow the search to DIE nodes of the desired type. In this case, additional filtering tools can be used to narrow the search further. | `dwarfdump <file> \| grep -B 5 "float \*" \| grep "DW_TAG_formal_parameter` to search only for parameter DIE nodes. |
| Print Complete DWARF Info | Use `dwarfdump --lookup=<address>` (potentially with `--show-children` and/or `--show-parents`) for each matching DIE node's address to print information about them in a uniform format. |

### Scripted Search
Sometimes, searching with filtering tools is too complex or produces inconsistent or incomplete results. In highly complex cases, such as searching for DIE nodes with multiple exact attribute values. In these cases, it is easiest to write a Python script leveraging the `pyelftools` package to parse and search DWARF files. Resort to this only if the filtering approach fails or becomes to complex.