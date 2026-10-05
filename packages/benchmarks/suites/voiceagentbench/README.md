# VoiceAgentBench (vendored)

Vendored from [Patil et al., arXiv:2510.07978](https://arxiv.org/abs/2510.07978). 5,757 voice queries across six suites measuring voice-in → tool-call-out accuracy: single, parallel, sequential, multi-turn state threading, safety refusal, and multilingual.

## Development

Install the shared Python support package from the repository root with `python -m pip install ./packages/benchmarks` before installing this suite.

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```
