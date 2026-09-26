#!/usr/bin/env bash
# Check every ELF header, including every archive member, without extraction.
set -euo pipefail
executable=0
if [ "${1:-}" = --executable ]; then executable=1; shift; fi
if [ "$#" -ne 1 ] || [ ! -s "$1" ]; then
    echo 'Expected one nonempty RISC-V ELF file or archive.' >&2
    exit 1
fi
shared=0
case "$1" in *.so|*.so.*) shared=1;; esac
headers="$(LC_ALL=C readelf --file-header -- "$1")"
printf '%s\n' "$headers" | awk -v shared="$shared" -v executable="$executable" '
    /^ELF Header:/ { count++ }
    /^File:/ { archives++ }
    /Type:/ { if ($2 == "DYN") dynamic++; if ($2 == "EXEC" || $2 == "DYN") programs++ }
    /Class:/ { if ($2 == "ELF64") classes++ }
    /Data:/ { if ($0 ~ /little endian/) endian++ }
    /Machine:/ { if ($2 == "RISC-V") machines++ }
    /Flags:/ { if ($0 ~ /double-float ABI/) abi++ }
    END { exit !(count > 0 && classes == count && endian == count && machines == count && abi == count && (!executable || (count == 1 && programs == 1 && archives == 0)) && (!shared || (count == 1 && dynamic == 1 && archives == 0))) }
'
