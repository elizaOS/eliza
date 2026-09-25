# hermes-adapter

Bridge adapter connecting the elizaOS benchmark suite to [hermes-agent](https://github.com/NousResearch/hermes-agent) (NousResearch).

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```

Runtime selection prefers explicit client arguments, then `HERMES_REPO_PATH` and
`HERMES_RUNTIME_PYTHON`. Otherwise it uses the managed `.eliza/agents/hermes-agent-src`
checkout or the standard `~/.hermes/hermes-agent` installation, checking `.venv`
then `venv` for its Python. Health checks verify the selected native runtime.
