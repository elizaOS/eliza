# Program Binaries

This directory should contain pre-compiled Solana program binaries (.so files).

## Required Programs for Phase 1

Per the Phase 1 specification:
- `jupiter.so` - Jupiter Aggregator
- `orca.so` - Orca Whirlpool
- `drift.so` - Drift Protocol

## Obtaining Programs

For Phase 1, Surfpool can clone programs directly from devnet/mainnet:

```bash
surfpool start --clone JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 --url devnet
```

## Note

For initial testing, the benchmark works with simulated pools.
Real program deployment is a future enhancement.
