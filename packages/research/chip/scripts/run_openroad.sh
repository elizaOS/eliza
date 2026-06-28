#!/usr/bin/env sh
set -eu

if ! command -v openroad >/dev/null 2>&1; then
    echo "OpenROAD missing. The entry Tcl is ready at pd/openroad/e1_soc.tcl."
    exit 1
fi

openroad pd/openroad/e1_soc.tcl
