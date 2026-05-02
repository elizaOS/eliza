.PHONY: format check build test

format:
	cargo fmt

check:
	cargo clippy --no-deps -- --deny warnings

build:
	cargo build

test:
	cargo test