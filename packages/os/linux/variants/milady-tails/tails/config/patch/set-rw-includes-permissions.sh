#!/bin/sh

set -eu
set -x

SCRIPT_DIR=$(readlink -f "$(dirname "$0")")
INCLUDES_DIR="${SCRIPT_DIR}/rw-includes"

# Since these files are meant to be modifiable from within the VM the
# libvirt-qemu user must be able to write to them
setfacl --default -m user:libvirt-qemu:rwX "${INCLUDES_DIR}"
