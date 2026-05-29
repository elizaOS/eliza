#!/bin/bash

set -e
set -u

if [ ! -x /usr/bin/zopflipng ]; then
    echo "Please install the \"zopfli\" package." >&2
    exit 1
fi

if [ ! -x /usr/bin/mat2 ]; then
    echo "Please install the \"mat2\" package." >&2
    exit 1
fi

for image in "${@}" ; do
    mat2 "${image}"
    cleaned_image="${image%.*}.cleaned.${image##*.}"
    zopflipng --filters=0me -m -y "${cleaned_image}" "${image}"
    rm "${cleaned_image}"
done
