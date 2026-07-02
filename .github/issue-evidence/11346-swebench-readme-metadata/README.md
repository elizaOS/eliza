# Issue #11346 SWE-bench README metadata evidence

Date: 2026-07-02
Host: Linux container, Python 3.12.3

## Change

`packages/benchmarks/swe_bench/pyproject.toml` now points `project.readme` at
the existing `README.md` file instead of the deleted `RESEARCH.md` file. The
README's stale reference back to `RESEARCH.md` was also removed so the packaged
long description does not point readers at a missing file.

## Validation

```bash
python3 - <<'PY'
from pathlib import Path
import tomllib
root = Path('packages/benchmarks/swe_bench')
config = tomllib.loads((root/'pyproject.toml').read_text())
readme = root / config['project']['readme']
print(f"readme={readme}")
print(f"exists={readme.exists()}")
if not readme.exists():
    raise SystemExit(1)
PY
```

Result: `readme=packages/benchmarks/swe_bench/README.md`, `exists=True`.

```bash
python3 -m pytest packages/benchmarks/swe_bench/tests -q
```

Result: 131 passed in 22.49s.

```bash
python3 -m build packages/benchmarks/swe_bench --sdist --wheel --outdir /tmp/eliza-swebench-build
```

Result: successfully built `elizaos_swe_bench-2.0.0.tar.gz` and
`elizaos_swe_bench-2.0.0-py3-none-any.whl`.

```bash
git diff --check
```

Result: passed.

## Additional Windows reviewer follow-up

After review, the top-level SWE-bench README still referenced the deleted
`RESEARCH.md`; that stale sentence was removed so the packaged long
description is self-contained.

```bash
python - <<'PY'
from pathlib import Path
import tomllib
root = Path('packages/benchmarks/swe_bench')
config = tomllib.loads((root / 'pyproject.toml').read_text())
readme = root / config['project']['readme']
print(f"readme={readme}")
print(f"exists={readme.exists()}")
if not readme.exists():
    raise SystemExit(1)
PY
rg -n "RESEARCH\\.md" packages/benchmarks/swe_bench
python -m build packages/benchmarks/swe_bench --sdist --wheel --outdir %TEMP%/eliza-swebench-build-11620
git diff --check
```

Result on Windows/Python 3.12.10: metadata readme exists, no remaining
`RESEARCH.md` references under `packages/benchmarks/swe_bench`, package build
successfully produced the sdist and wheel, and `git diff --check` passed.

## Evidence not applicable to this PR

- Real-model benchmark trajectory: N/A - this PR fixes Python package metadata
  for the SWE-bench harness and does not change benchmark execution, prompts,
  providers, scoring, or model behavior.
- Screenshots/video: N/A - no UI surface changed.
- Docker SWE-bench evaluation run: N/A - the change is packaging metadata only;
  the package build and unit suite exercise the broken metadata path directly.
