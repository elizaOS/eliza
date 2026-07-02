# #11504 Stage-1 Code Reply Evidence

Issue: https://github.com/elizaOS/eliza/issues/11504

## What Was Verified

- The Stage-1 low-quality reply heuristic no longer rejects bare code,
  prose-plus-fenced code, pretty-printed JSON, or markdown divider replies just
  because they contain repeated-character runs.
- Whole-reply degenerate repetition is still replaced with the clear fallback
  reply.
- A live `gemma-4-31b` run through the real v5 runtime path returned a direct
  `simple` reply containing an unfenced Python code body, with no planner or
  tool stages.

## Commands

```bash
bun run --cwd packages/core prebuild
bun run --cwd packages/core test src/__tests__/message-runtime-stage1.test.ts
bunx @biomejs/biome check packages/core/src/services/message.ts packages/core/src/__tests__/message-runtime-stage1.test.ts .github/issue-evidence/11504-stage1-code-replies/README.md
bun run --cwd packages/core typecheck
bun run install:light
bun run verify

test -e packages/plugins || ln -s ../plugins packages/plugins
ELIZA_TRAJECTORY_DIR=.github/issue-evidence/11504-stage1-code-replies/live-cerebras-current bun run --conditions eliza-source packages/scripts/run-eliza-cerebras.ts --message 'Complete this Python function. Reply with only the code body, no markdown: def has_close_elements(numbers: list[float], threshold: float) -> bool:' --model gemma-4-31b
if [ -L packages/plugins ]; then rm packages/plugins; fi
```

## Results

- Focused Stage-1 suite: `1 passed`, `75 passed`.
- Biome touched-file check: `Checked 2 files ... No fixes applied.`
- `packages/core` typecheck: exit 0.
- Full `bun install` was attempted after rebasing onto `origin/develop`, but
  postinstall artifact sync was still at `7.0 MiB of 971 MiB` with an estimated
  `141m 59s` remaining, so it was stopped before completion.
- `bun run install:light`: exit 0; artifact sync skipped with
  `ELIZA_SKIP_ARTIFACT_SYNC=1`.
- `bun run verify`: failed before typecheck/lint in `audit:type-safety-ratchet`
  on the current repo baseline (`as unknown as: 77 / 76`, `?? 0`
  core/agent/app-core: `376 / 375`). This branch changes only a test file and
  evidence artifacts, with no production-source diff.
- Live runtime trajectory:
  `live-cerebras-current/93432706-b3b2-08ea-ab6a-ba55340a8848/tj-74b5c8fef7d6a9.json`
- Secret scan on the live trajectory found no API key or authorization header
  strings.

Manual trajectory review:

- `status`: `finished`
- stage kinds: `messageHandler`
- model: `gemma-4-31b`
- model response selected `contexts:["simple"]`, `requiresTool:false`
- model reply was an unfenced Python code body:

```python
for i in range(len(numbers)):
        for j in range(i + 1, len(numbers)):
            if abs(numbers[i] - numbers[j]) < threshold:
                return True
    return False
```

The direct runtime result printed the same code body instead of
`I'm not sure how to answer that.`
