# #9943 feed stale skip cleanup

## Scope

Removed `packages/feed/packages/testing/e2e/landing-page-blog-links.spec.ts`.

The suite was permanently disabled with a top-level `test.skip()` because the
landing page redirects to `/feed` and the blog CTA/footer links it asserted are
not exposed on that route. Keeping the file inflated the feed skip count while
providing no runnable coverage.

## Skip inventory delta

Command:

```bash
python3 - <<'PY'
from pathlib import Path
patterns = ['test.skip(', 'it.skip(', 'describe.skip(']
count=0
files=set()
for p in Path('packages/feed').rglob('*'):
    if p.suffix not in {'.ts','.tsx','.js','.jsx'}: continue
    text=p.read_text(errors='ignore')
    n=sum(text.count(x) for x in patterns)
    if n:
        count+=n; files.add(str(p))
print(count)
print(len(files))
PY
```

Before: 208 skip calls across 42 files.

After: 207 skip calls across 41 files.

## Validation

Completed:

- `bun install --frozen-lockfile` passed.
- `git diff --check` passed.
- `bun run --cwd packages/core build` passed. This matches the feed CI
  pre-step that builds `@elizaos/core` before running feed tests.
- `bun run --cwd packages/feed test:unit` passed: 388 files passed, 0 failed.
- `bun run verify` failed before package validation at
  `audit:type-safety-ratchet`: current `?? {}` count is 378 against a 377
  baseline in core/agent/app-core. This branch only removes a feed e2e spec and
  adds this evidence file, so the ratchet drift is unrelated.

Focused Biome was attempted with:

```bash
bunx @biomejs/biome check --config-path biome.json --files-ignore-unknown=true \
  packages/feed/packages/testing/e2e \
  .github/issue-evidence/9943-feed-stale-blog-e2e.md
```

It processed no files because the only source change is a deleted test file and
the evidence markdown path is ignored by the configured Biome inputs.
