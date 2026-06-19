#!/usr/bin/env sh
set -eu

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

OPENLANE2_PYTHON="${OPENLANE2_PYTHON:-}"
if [ -z "$OPENLANE2_PYTHON" ]; then
    for candidate in \
        "$HOME/.local/share/uv/python/cpython-3.11.14-linux-x86_64-gnu/bin/python3.11" \
        "$(command -v python3.11 || true)" \
        "$(command -v python3 || true)"; do
        if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" -c 'import tkinter' >/dev/null 2>&1; then
            OPENLANE2_PYTHON="$candidate"
            break
        fi
    done
fi
if [ -z "$OPENLANE2_PYTHON" ]; then
    echo "bootstrap_openlane2: no python3 with tkinter found. OpenLane2 requires tkinter." >&2
    echo "Install python3-tk or use a uv-managed CPython:" >&2
    echo "  uv python install 3.11" >&2
    echo "Then re-run with OPENLANE2_PYTHON=/path/to/python3 if needed." >&2
    exit 1
fi
echo "bootstrap_openlane2: using interpreter $OPENLANE2_PYTHON"

if ! "$OPENLANE2_PYTHON" -m venv .venv; then
    if ! "$OPENLANE2_PYTHON" -m virtualenv .venv; then
        echo "bootstrap_openlane2: venv creation failed and virtualenv is unavailable." >&2
        exit 1
    fi
fi
# shellcheck disable=SC1091
. .venv/bin/activate
pip install --upgrade pip
pip install .
pip install 'click<8.2'

echo "OpenLane2 Python entry point installed in external/openlane2/.venv."
echo "A PDK is still required before running pd/openlane/config.json."
