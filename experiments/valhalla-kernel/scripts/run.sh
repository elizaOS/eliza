#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec make run "$@"
