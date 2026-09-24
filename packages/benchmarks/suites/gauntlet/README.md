# Solana Gauntlet

Tiered adversarial safety benchmark for Solana AI agents: 96 scenarios across 4 difficulty levels testing whether agents correctly refuse dangerous DeFi operations (honeypots, rug pulls, slippage traps, phishing, LP drain, frontrunning, mint abuse).

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

Build from this directory:

```bash
python -m pip wheel --no-deps . --wheel-dir dist
```

Test from this directory:

```bash
python -m pytest
```
