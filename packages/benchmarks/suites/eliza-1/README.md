# @elizaos/bench-eliza-1

Quality and performance benchmark for eliza-1 models.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/eliza-1 typecheck  # static validation
```

No standalone build script is defined; this package is consumed or executed from source.

Run the harness with `bun run --cwd packages/benchmarks/suites/eliza-1 start`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.

Run the Python cross-framework runner regression tests with
`python -m pytest packages/benchmarks/suites/eliza-1/tests/test_harness_runner.py`
from the repository root. That runner scores complete JSON or native structured
arguments against the exact decision schema. Missing token usage stays null;
summary coverage identifies how many cases have observed usage. These tests do
not establish live framework quality. Typechecking is not a substitute for runtime tests.

Run the TypeScript HTTP-to-report checks with
`bun run --cwd packages/benchmarks/suites/eliza-1 test`
using Bun 1.4.2. The required server CI lane runs this command and collects
test-case receipts. Node 24.15.0 can also run the file with `node --test`.
Reported token counts use observed provider usage; local
decode modes without token receipts show n/a. Accuracy includes parse failures.

The Python runner defaults to the 32-case manual decision set (19 RESPOND,
10 IGNORE, 3 STOP), matching the local decision task. The 59-case derived set
is still available with `--fixture-set derived`, but every label is RESPOND;
it is a single-class regression set, not evidence of decision quality. Reports
include full-corpus class counts and the majority-label baseline.

The orchestrator withholds decision-quality scores when evaluated cases lack
expected labels or omit a decision class. It recomputes decision correctness
from saved outputs and labels; reported summaries remain diagnostic evidence.
This class-coverage check does not establish full-corpus or live-run provenance.
