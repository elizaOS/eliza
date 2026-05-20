#!/usr/bin/env sh
set -eu

# LibreLane pinned reference for reproducible PD flows.
# LibreLane is the FOSSi-Foundation successor to efabless/openlane2; the
# upstream openlane2 repo has been dormant since 2.4.0.dev1.
#
# If you want a different release, update this script in lockstep with
# external/librelane/pin-manifest.json and the digest documented in
# docs/toolchain/reproducibility.md.

LIBRELANE_REPO="${LIBRELANE_REPO:-https://github.com/librelane/librelane.git}"
LIBRELANE_TAG="${LIBRELANE_TAG:-3.0.3}"
LIBRELANE_SHA="${LIBRELANE_SHA:-1e4f4d5bf9d2693798b12dc0c1cd0337ad266a0d}"

mkdir -p external
if [ ! -d external/librelane ]; then
    git clone "$LIBRELANE_REPO" external/librelane
fi

cd external/librelane
git fetch --tags origin

git checkout --detach "$LIBRELANE_SHA"
resolved="$(git rev-parse HEAD)"
if [ "$resolved" != "$LIBRELANE_SHA" ]; then
    echo "bootstrap_librelane: resolved HEAD ($resolved) != pinned SHA ($LIBRELANE_SHA)" >&2
    exit 1
fi
echo "LibreLane checked out at $LIBRELANE_SHA (tag $LIBRELANE_TAG)."

# LibreLane inherits OpenLane 2's unconditional tkinter import
# (librelane/common/tcl.py). Ubuntu's system python3 ships without tkinter
# unless python3-tk is apt-installed (requires sudo). Prefer a uv-managed
# CPython that bundles tkinter; fall back to system python3 and let the
# import error surface explicitly.
LIBRELANE_PYTHON="${LIBRELANE_PYTHON:-}"
if [ -z "$LIBRELANE_PYTHON" ]; then
    for candidate in \
        "$HOME/.local/share/uv/python/cpython-3.11.14-linux-x86_64-gnu/bin/python3.11" \
        "$(command -v python3.11 || true)" \
        "$(command -v python3 || true)"; do
        if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" -c 'import tkinter' >/dev/null 2>&1; then
            LIBRELANE_PYTHON="$candidate"
            break
        fi
    done
fi
if [ -z "$LIBRELANE_PYTHON" ]; then
    echo "bootstrap_librelane: no python3 with tkinter found. LibreLane requires tkinter." >&2
    echo "Install python3-tk (apt) or use a uv-managed CPython:" >&2
    echo "  uv python install 3.11" >&2
    echo "Then re-run, optionally with LIBRELANE_PYTHON=/path/to/python3." >&2
    exit 1
fi
echo "bootstrap_librelane: using interpreter $LIBRELANE_PYTHON"

if ! "$LIBRELANE_PYTHON" -m venv .venv; then
    if ! "$LIBRELANE_PYTHON" -m virtualenv .venv; then
        echo "bootstrap_librelane: venv creation failed and virtualenv is unavailable." >&2
        exit 1
    fi
fi
# shellcheck disable=SC1091
. .venv/bin/activate
pip install --upgrade pip
pip install .

echo "LibreLane Python entry point installed in external/librelane/.venv."
echo "A PDK is still required before running pd/openlane/config.json."
