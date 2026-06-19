#!/usr/bin/env bash
#set -xu

# We're not upstream for this script, so:
# shellcheck disable=SC2034,SC2064,SC2086,SC2181

# Imported from https://github.com/vagrant-libvirt/vagrant-libvirt
# at commit dda5d4e1c467017c773639f0cc3df3a78898ae0b:
#
# Copyright (c) 2013 Lukas Stanek
# 
# MIT License
# 
# Permission is hereby granted, free of charge, to any person obtaining
# a copy of this software and associated documentation files (the
# "Software"), to deal in the Software without restriction, including
# without limitation the rights to use, copy, modify, merge, publish,
# distribute, sublicense, and/or sell copies of the Software, and to
# permit persons to whom the Software is furnished to do so, subject to
# the following conditions:
# 
# The above copyright notice and this permission notice shall be
# included in all copies or substantial portions of the Software.
# 
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
# EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
# MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
# NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
# LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
# OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
# WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

error() {
    local msg="${1}"
    echo "==> ERROR: ${msg}"
    exit 1
}

usage() {
    echo "Usage: ${0} IMAGE [BOX] [Vagrantfile.add]"
    echo
    echo "Package a qcow2 image into a vagrant-libvirt reusable box"
}

# Print the image's backing file
backing(){
    local img=${1}
    qemu-img info "$img" | grep 'backing file:' | cut -d ':' -f2
}

# Rebase the image
rebase(){
    local img=${1}
    qemu-img rebase -p -b "" "$img"
    [[ "$?" -ne 0 ]] && error "Error during rebase"
}

# Is absolute path
isabspath(){
    local path=${1}
    [[ "$path" =~ ^/.* ]]
}

if [ -z "$1" ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    usage
    exit 1
fi

IMG=$(readlink -e "$1")
[[ "$?" -ne 0 ]] && error "'$1': No such image"

IMG_DIR=$(dirname "$IMG")
IMG_BASENAME=$(basename "$IMG")

BOX=${2:-}
# If no box name is supplied infer one from image name
if [[ -z "$BOX" ]]; then
    BOX_NAME=${IMG_BASENAME%.*}
    BOX=$BOX_NAME.box
else
    BOX_NAME=$(basename "${BOX%.*}")
fi

[[ -f "$BOX" ]] && error "'$BOX': Already exists"

CWD=$(pwd)
TMP_DIR="$CWD/_tmp_package"
TMP_IMG="$TMP_DIR/box.img"

mkdir -p "$TMP_DIR"

[[ ! -r "$IMG" ]] && error "'$IMG': Permission denied"

if [ -n "$3" ] && [ -r "$3" ]; then
  VAGRANTFILE_ADD="$(cat $3)"
fi

# We move / copy (when the image has master) the image to the tempdir
# ensure that it's moved back / removed again
if [[ -n $(backing "$IMG") ]]; then
    echo "==> Image has backing image, copying image and rebasing ..."
    trap "rm -rf $TMP_DIR" EXIT
    cp "$IMG" "$TMP_IMG"
    rebase "$TMP_IMG"
else
    if fuser -s "$IMG"; then
        error "Image '$IMG_BASENAME' is used by another process"
    fi

    # move the image to get a speed-up and use less space on disk
    trap 'mv "$TMP_IMG" "$IMG"; rm -rf "$TMP_DIR"' EXIT
    mv "$IMG" "$TMP_IMG"
fi

cd "$TMP_DIR"

# We round the virtual image size to the next integer since the
# fog-libvirt library does not seem to properly handle floating point.
IMG_SIZE=$(qemu-img info --output=json "$TMP_IMG" | jq '."virtual-size"/pow(1024; 3) | ceil')

echo "{$IMG_SIZE}"

cat > metadata.json <<EOF
{
    "provider": "libvirt",
    "format": "qcow2",
    "virtual_size": ${IMG_SIZE}
}
EOF

cat > Vagrantfile <<EOF
Vagrant.configure("2") do |config|

  config.vm.provider :libvirt do |libvirt|

    libvirt.driver = "kvm"
    libvirt.host = ""
    libvirt.connect_via_ssh = false
    libvirt.storage_pool_name = "default"

  end

${VAGRANTFILE_ADD:-}
end
EOF

echo "==> Creating box, tarring and gzipping"

if type pigz >/dev/null 2>/dev/null; then
  GZ="pigz"
else
  GZ="gzip"
fi
tar cv -S --totals ./metadata.json ./Vagrantfile ./box.img | $GZ -c > "$BOX"

# if box is in tmpdir move it to CWD before removing tmpdir
if ! isabspath "$BOX"; then
    mv "$BOX" "$CWD"
fi

echo "==> ${BOX} created"
echo "==> You can now add the box:"
echo "==>   'vagrant box add ${BOX} --name ${BOX_NAME}'"
