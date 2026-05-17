#!/bin/bash

set -e
set -u

if [ ! -x /usr/bin/qrencode ]; then
    echo "Please install the \"qrencode\" package." >&2
    exit 1
fi

for code in "${@}" ; do
    file="$(echo "${code}" | sed -r "s#^http(s)?://##;s#/\$##;s#[/.?=]#_#g;s#_+#_#g")"
    qrencode -o "${file}.png" -s 5 "${code}"
    "$(dirname "${0}")/compress-image.sh" "${file}.png"
done
