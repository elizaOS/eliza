# `action.ATTACHMENT@packages/prompts/specs/actions/core.json.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/prompts/specs/actions/core.json`
- **Token count**: 70
- **Last optimized**: never
- **Action**: ATTACHMENT
- **Similes**: READ_ATTACHMENT, SAVE_ATTACHMENT_AS_DOCUMENT, OPEN_ATTACHMENT, INSPECT_ATTACHMENT, READ_URL, OPEN_URL, READ_WEBPAGE

## Current text
```
Read current or recent attachments and link previews, or save readable attachment content as a document. Use action=read for extracted text, transcripts, page content, or media descriptions. Use action=save_as_document to store readable attachment content in the document store.
```

## Compressed variant
```
Attachment action=read or save_as_document; current/recent files, link previews, extracted text, transcripts, media descriptions.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (129 chars vs 278 chars — 54% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
