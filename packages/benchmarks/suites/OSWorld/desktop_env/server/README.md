# OSWorld desktop server

Flask server exposing screenshot, accessibility, and desktop-control operations
inside the benchmark VM. It requires a graphical session, OS accessibility
support, and the dependencies in `requirements.txt`. Run this control server
only in the isolated benchmark environment.

No separate build is required. From this directory inside the VM:

```bash
python -m pip install -r requirements.txt
python main.py
```

`osworld_server.service` describes the Linux service layout and display/session
environment; adjust its paths and user to match the VM.

Test the local adapter from `packages/benchmarks/suites/OSWorld`:

```bash
python -m pytest tests
```

Actual desktop-control validation requires the running VM and suite tasks.
