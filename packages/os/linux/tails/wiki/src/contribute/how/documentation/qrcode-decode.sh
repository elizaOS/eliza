#!/bin/bash

set -e
set -u

if [ ! -x /usr/bin/zbarimg ]; then
    echo "Please install the \"zbar-tools\" package." >&2
    exit 1
fi

for code in "${@}" ; do
    echo "${code}"
    zbarimg "${code}"
done
