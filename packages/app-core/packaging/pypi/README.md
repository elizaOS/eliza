# elizaos-app

Python launcher for the elizaOS App.

This package provides the `elizaos-app` command for environments that install
applications through PyPI. The launcher validates that Node.js is available,
then delegates to the version-matched npm `elizaos` command.

```bash
pip install elizaos-app
elizaos-app --help
```

Node.js 24 or newer must be available on `PATH`.

## Reproducible release build

The source tree carries an exact copy of the repository MIT `LICENSE`.
`verify_artifacts.py` opens both output archives and proves that the wheel and
sdist contain those exact bytes plus PEP 639 license metadata.

Build tooling is intentionally separate from runtime dependencies. The reviewed
direct pins are Build 1.4.4, PyYAML 6.0.3, Setuptools 82.0.1, Twine 6.2.0,
and Wheel 0.47.0; `build-requirements.lock` pins and hashes their full Python
3.9-3.14 dependency closure. Release and CI lanes install that same lock and
disable PEP 517 build isolation so an unreviewed backend cannot be fetched
during the build or manifest validation.

```bash
python -m venv .venv-build
. .venv-build/bin/activate
python -m pip install --require-hashes --requirement build-requirements.lock
python -m build --no-isolation
python verify_artifacts.py dist
python -m twine check dist/*
```
