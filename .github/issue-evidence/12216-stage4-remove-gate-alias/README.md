# Stage 4 Remove Gate Alias Evidence

Issue: #12321

PR scope:

- Remove the `ELIZA_PUBLISH_ALLOW_GATE_ALIAS` publish bypass from the Eliza-1 orchestrator.
- Require `evals/aggregate.json` to carry independent `e2e_loop_ok` and `thirty_turn_ok` booleans.
- Keep a regression test showing the retired env var no longer lets a missing `e2e_loop_ok` publish.

Verification:

```bash
python3 -m pytest packages/training/scripts/publish/test_orchestrator.py -q -k 'missing_e2e_loop_ok_blocks_publish or dry_run_succeeds_on_fixture'
# .. [100%] 2 passed

python3 -m pytest packages/training/scripts/publish/test_orchestrator.py -q
# .................................................... [100%] 52 passed

python3 -m py_compile packages/training/scripts/publish/orchestrator.py packages/training/scripts/publish/test_orchestrator.py
# passed
```
