# Autonomous (Python)

This example runs a **sandboxed autonomous loop** using:

- `elizaos-plugin-local-ai` (local GGUF inference)
- `elizaos-plugin-shell` (restricted shell)
- `elizaos-plugin-inmemorydb` (ephemeral memory)

Entry point: `autonomous.py`

## Run

```bash
cd examples/autonomous/python
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python autonomous.py
```

## Stop

- Create the stop file (default): `examples/autonomous/sandbox/STOP`

```bash
touch examples/autonomous/sandbox/STOP
```

## Config

See `env.example.txt` for the supported environment variables.
