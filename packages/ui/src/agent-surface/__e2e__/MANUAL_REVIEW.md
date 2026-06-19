# Agent-surface e2e — manual review

Run: `bun run --cwd packages/ui test:agent-surface-e2e` (real headless chromium,
no app server). Screenshots land in `output/`.

## Verdict: **good**

`output/agent-surface-highlight.png` (agent-highlight mode) and
`output/agent-surface-rest.png` (rest) capture the agent surface driven entirely
through the capability bridge, the same path the floating pill uses.

What the run proves, in a real browser:

- **list-elements** enumerates the view's addressable controls (`name`,
  `increment`, `status-online`) with role/label/value/focus.
- **agent-fill** types into the controlled `name` input and the view state
  reacts (`name=Ada Lovelace`).
- **agent-click** activates the `Increment` handler twice (`count=2`).
- **agent-focus** + **get-focus** move and report focus (`name`).
- **set-highlight** renders the indicator overlay — every addressable element
  gets a labelled orange badge (the "indicators of elements" requirement), and
  the focused input is ringed.
- Text that should be graphic is graphic: `IconTag` chips (`finance`, `error`)
  and the `Online` status pill, not bare text.

This is the contract every converted view inherits: the floating pill can list,
anchor to, fill, click, focus, and visually indicate any registered element from
voice or text, and the view reacts — no in-view chat required.
</content>
