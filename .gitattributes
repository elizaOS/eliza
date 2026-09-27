*.patch -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
# Unified-diff context prefixes precede literal source tabs; those are patch data.
# Patch bytes are hashed (patches/CHECKSUMS.sha256) and applied verbatim by bun,
# so they must stay byte-identical across platforms — never let a Windows
# checkout (autocrlf) rewrite them to CRLF.
patches/CHECKSUMS.sha256 -text

# Source files must check out with LF everywhere: Windows runners default to
# core.autocrlf=true, and a CRLF checkout makes vitest's transform pipeline
# reject otherwise-valid modules ("SyntaxError: Invalid or unexpected token"
# at collection — reproduced by CRLF-converting run-mobile-build.ts on
# Linux). Biome also formats LF-only, so CRLF working copies churn
# format:check.
*.mjs text eol=lf
*.cjs text eol=lf
*.js text eol=lf
*.jsx text eol=lf
*.ts text eol=lf
*.tsx text eol=lf
*.mts text eol=lf
*.cts text eol=lf
*.json text eol=lf
*.java text eol=lf
*.yml text eol=lf
*.yaml text eol=lf

# This adversarial fixture deliberately includes control-character source
# literals. Force a textual diff so security-relevant assertion changes remain
# reviewable instead of appearing as an opaque binary replacement.
plugins/plugin-personal-assistant/test/connector-payload-fuzz.test.ts diff

# The relocated benchmark cost model is hashed corpus input. Preserve its
# original trailing spaces and bytes, including on Windows checkouts.
packages/benchmarks/scripts/terminal-bench/llm-inference-batching-scheduler/cost_model.py -text whitespace=-blank-at-eol

# Vendored evaluators and benchmark corpora retain upstream bytes, including
# whitespace and line endings. These are inputs, not first-party formatting.
packages/benchmarks/suites/agentbench/upstream/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
packages/benchmarks/suites/mint/upstream/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
packages/benchmarks/suites/realm/upstream/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
packages/benchmarks/suites/webshop/upstream/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
packages/benchmarks/suites/tau-bench/elizaos_tau_bench/upstream/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
packages/benchmarks/suites/nl2repo/test_files/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
packages/benchmarks/suites/terminal-bench/tasks/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
packages/benchmarks/suites/OSWorld/mm_agents/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
packages/benchmarks/suites/OSWorld/desktop_env/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
packages/benchmarks/suites/OSWorld/monitor/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
packages/benchmarks/suites/bfcl/executable_runtime/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
packages/benchmarks/suites/action-calling/corpus/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab
packages/benchmarks/suites/openclaw-benchmark/openclaw/** -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab

# Preserve literal benchmark prompt/document content in these source fixtures.
packages/benchmarks/scripts/osworld/python/run_coact.py -text whitespace=-blank-at-eol
packages/benchmarks/suites/context-bench/tests/conftest.py -text whitespace=-blank-at-eol
