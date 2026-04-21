#!/usr/bin/env sh
# Run cargo check when cargo is available (CI / local Rust dev). No-op otherwise
# so `turbo run typecheck` succeeds on machines without the Rust toolchain.
if ! command -v cargo >/dev/null 2>&1; then
	echo "[@elizaos/rust] typecheck: cargo not in PATH, skipping"
	exit 0
fi
export PATH="${HOME}/.cargo/bin:${PATH}"
exec cargo check --lib --features native
