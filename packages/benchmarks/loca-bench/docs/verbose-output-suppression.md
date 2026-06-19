# Runner Output Mode

## Overview

`loca run` now runs in quiet output mode only.

- The runner-level `--verbose` / `-v` option was removed.
- Runtime behavior is fixed to the previous non-verbose path.
- MCP/output suppression still uses `LOCA_QUIET=1` for this runner.

## Current Behavior

When running `loca run`, output is now always the progress-oriented view plus final summary.

Example:
```bash
loca run -c task-configs/final_8k_set_config.json -m gpt-4
```

`loca run --verbose` is no longer supported.
