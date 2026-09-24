# Agent Trust & Security Benchmark

Adversarial security detection benchmark: evaluates an agent's ability to identify prompt injection, social engineering, impersonation, credential theft, privilege escalation, data exfiltration, resource abuse, and content policy violations. 165 cases across 9 categories (130 malicious + 35 benign false-positive controls).

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
