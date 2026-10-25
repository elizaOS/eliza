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

Run the network-free vLLM authentication regression tests without provider SDKs:

```bash
python3 -m unittest discover -s tests -p test_vllm_auth.py -v
```

The removed Basic-auth override originated in the [upstream OSWorld import](https://github.com/xlang-ai/OSWorld/commit/f593f35b1c50c3a1c3fa3da7743677743a7092ca).
The original imported engine was byte-identical to that upstream implementation.
The author's [OS-Symphony engine](https://github.com/OS-Copilot/OS-Symphony/blob/08acba777713e29905654e2ceb57c51080fdc296/mm_agents/os_symphony/core/engine.py)
already uses the configured API key without the override. Public provenance does
not establish credential retirement: the historical scan finding remains blocked
until the service owner confirms revocation. Do not copy or try those credentials.
