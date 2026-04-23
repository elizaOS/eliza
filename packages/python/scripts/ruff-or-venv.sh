#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

if command -v uv >/dev/null 2>&1; then
	exec uv run --extra dev ruff "$@"
fi

if command -v python3 >/dev/null 2>&1 && python3 -c "import ruff" >/dev/null 2>&1; then
	exec python3 -m ruff "$@"
fi

if ! command -v python3 >/dev/null 2>&1; then
	echo "[@elizaos/python] ruff: python3 is not available"
	exit 127
fi

tmpdir=$(mktemp -d)
cleanup() {
	rm -rf "$tmpdir"
}
trap cleanup EXIT INT TERM

python3 -m venv "$tmpdir"
"$tmpdir/bin/python" -m pip install -e ".[dev]" -q
"$tmpdir/bin/python" -m ruff "$@"
