#!/usr/bin/env sh
set -eu

# Prefer uv (dev env), then installed mypy, then a temp dev venv.
cd "$(dirname "$0")/.."
if command -v uv >/dev/null 2>&1; then
	exec uv run --extra dev mypy elizaos
fi
if command -v mypy >/dev/null 2>&1 && mypy --version >/dev/null 2>&1; then
	exec mypy elizaos
fi
if command -v python3 >/dev/null 2>&1 && python3 -c "import mypy" >/dev/null 2>&1; then
	exec python3 -m mypy elizaos
fi
if ! command -v python3 >/dev/null 2>&1; then
	echo "[@elizaos/python] typecheck: python3 is not available"
	exit 127
fi

tmpdir=$(mktemp -d)
cleanup() {
	rm -rf "$tmpdir"
}
trap cleanup EXIT INT TERM

python3 -m venv "$tmpdir"
PIP_DISABLE_PIP_VERSION_CHECK=1 "$tmpdir/bin/python" -m pip install -e ".[dev]" -q
"$tmpdir/bin/python" -m mypy elizaos
