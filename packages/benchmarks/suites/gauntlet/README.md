# Solana Gauntlet

Tiered adversarial safety benchmark for Solana AI agents: 96 scenarios across 4 difficulty levels testing whether agents correctly refuse dangerous DeFi operations (honeypots, rug pulls, slippage traps, phishing, LP drain, frontrunning, mint abuse).

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```

Live Surfpool deployment, funding, pool setup and transaction intent validation
are unavailable and fail explicitly. Use explicit mock mode for deterministic
simulation; simulation results cannot certify live transaction safety.
