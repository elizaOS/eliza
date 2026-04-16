#!/usr/bin/env sh
# Run cargo test when cargo is available. No-op otherwise so `turbo run test`
# succeeds on machines without the Rust toolchain.
if ! command -v cargo >/dev/null 2>&1; then
	echo "[@elizaos/rust] test: cargo not in PATH, skipping"
	exit 0
fi
export PATH="${HOME}/.cargo/bin:${PATH}"
exec cargo test
