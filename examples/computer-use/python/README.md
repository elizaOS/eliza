# Computer Use Example (Python)

This example uses the **Python ComputerUse plugin wrapper** directly.

## Run

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ../../../plugins/plugin-computeruse/python

# Optional (Windows local mode)
pip install computeruse-py

COMPUTERUSE_ENABLED=true python run.py
```

