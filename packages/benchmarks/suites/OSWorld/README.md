# OSWorld

Multimodal desktop agent benchmark: 369 real computer tasks spanning Chrome, LibreOffice, GIMP, VS Code, and more — arXiv:2404.07972.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No standalone wheel build is configured; run the Python sources directly.

Test from this directory:

```bash
python -m pytest
```

The OS Symphony vLLM engine uses the supplied API key (or `vLLM_API_KEY`) and
endpoint (or `vLLM_ENDPOINT_URL`). Authentication is the OpenAI-compatible Bearer
header derived from that key; the engine does not substitute bundled credentials.
