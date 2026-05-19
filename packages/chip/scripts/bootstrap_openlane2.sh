#!/usr/bin/env sh
set -eu

# OpenLane2 pinned reference for reproducible PD flows.
# The pinned tag should track the image digest in scripts/install_openlane_image.sh
# (currently ghcr.io/efabless/openlane2:2.4.0.dev1 @ sha256:bcaabac3...).
#
# TODO(toolchain-ci): if you want a different release, update both this script
# and scripts/install_openlane_image.sh in lockstep and refresh the digest
# documented in docs/toolchain/reproducibility.md.

OPENLANE2_REPO="${OPENLANE2_REPO:-https://github.com/efabless/openlane2.git}"
OPENLANE2_TAG="${OPENLANE2_TAG:-2.4.0.dev1}"
OPENLANE2_SHA="${OPENLANE2_SHA:-198d9cbf7dd4f38a947bd739588680297835bc44}"

mkdir -p external
if [ ! -d external/openlane2 ]; then
    git clone "$OPENLANE2_REPO" external/openlane2
fi

cd external/openlane2
git fetch --tags origin

git checkout --detach "$OPENLANE2_SHA"
resolved="$(git rev-parse HEAD)"
if [ "$resolved" != "$OPENLANE2_SHA" ]; then
    echo "bootstrap_openlane2: resolved HEAD ($resolved) != pinned SHA ($OPENLANE2_SHA)" >&2
    exit 1
fi
echo "OpenLane2 checked out at $OPENLANE2_SHA (tag $OPENLANE2_TAG)."

if ! python3 -m venv .venv; then
    if ! python3 -m virtualenv .venv; then
        echo "bootstrap_openlane2: python3 venv failed and virtualenv is unavailable." >&2
        echo "Install python3-venv or run: python3 -m pip install --user --break-system-packages virtualenv" >&2
        exit 1
    fi
fi
# shellcheck disable=SC1091
. .venv/bin/activate
pip install --upgrade pip
pip install .

echo "OpenLane2 Python entry point installed in external/openlane2/.venv."
echo "A PDK is still required before running pd/openlane/config.json."
