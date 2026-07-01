# #9943 Storybook Play Gate

Focused slice for #9943: the Storybook browser gate now waits for Storybook's
preview render phase to reach `finished` or `errored`, so autoplayed `play`
interaction assertions are complete before screenshots, a11y checks, and the
final verdict run. The report also records `playExpected` and `playPrepared`.

## Evidence

- `story-gate-play-report.json` - focused browser gate report for launcher
  stories. Summary: 7 stories, 7 good, 0 broken, `playPrepared=3`,
  `playExpected=3`.
- `pages-launcher-long-press-to-edit.png` - screenshot captured after the
  long-press `play` story finished.

## Commands

```bash
bun install --frozen-lockfile --ignore-scripts
bun run generate:action-search-keywords
bun run --cwd packages/ui build-storybook --output-dir storybook-static --quiet
node packages/ui/test/story-gate/run-story-gate.mjs --static-dir packages/ui/storybook-static --out test/story-gate/output-play-smoke --grep launcher --concurrency 2 --no-a11y
```

## N/A

- Android screenshot/screenrecord: N/A for this Storybook CI gate slice. The
  Android real-touch and sleep/wake #9943 slices are already covered by separate
  open PRs with device screenshots and recordings.
- Real LLM trajectory: N/A; no model path changed.
