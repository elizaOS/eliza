# openclaw/ — sandboxed benchmark runtime

Execution environment for the OpenClaw-Bench tasks. `runner.py` drives the LLM
tool loop against a `SandboxExecutor` (`sandbox.py` — subprocess isolation by
default, Docker via `--docker` using the `Dockerfile` here, which bakes
`standard_tasks.md` into the container as `/workspace/PRD.md`). `scenarios/`
holds the YAML task definitions; `scoring.py` and `validators.py` check
concrete outcomes (files created, commands executed, output correctness).

Run through the suite entrypoint one level up:

```bash
python ../eliza_adapter.py --task setup --mode execution
```
