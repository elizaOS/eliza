# Generation brief specification

> Status: scaffold. Implementation in milestone #11.

The generation brief is the prompt template the `usbeliza-codegen` plugin feeds to
`claude --print` (or `codex`, or the managed proxy) when building a new app or
patching an existing one.

## Skeleton (subject to milestone #11 refinement)

```
You are building a single-file <runtime> app for ElizaOS.

User intent: "<intent>"

Slug (you will not change this): <slug>

Constraints:
- Runtime: <webview | gtk4 | terminal>
- Single-file <entry>
- Use ONLY these declared capabilities; no others:
  <capability list, with per-cap notes>
- Apps run in bubblewrap. The host has no `<dom-ready>` event guarantee
  before capability handshakes complete.

User calibration (style/tone hints, not technical constraints):
<calibration block>

Existing source (omit on first build, present on rebuild):
<existing src or "(empty)">

Output a single JSON object with two fields:
{
  "manifest": <complete manifest.json per docs/manifest-spec.md>,
  "src": { "<relative path>": "<file contents>", ... }
}
```

## Why a structured output

The plugin parses Claude's stream-json output, extracts the JSON envelope, and
writes manifest + src atomically. Free-text replies are rejected by the validator
in `eliza-sandbox`; the codegen plugin retries up to twice (locked decision #16)
with a critique brief explaining the parse failure.
