# @elizaos/plugin-pdf

PDF reading and text extraction service for Eliza agents.

Register the plugin and retrieve PdfService through
`runtime.getService(ServiceType.PDF)`. Import services and types from the single Node
entry `@elizaos/plugin-pdf`. Native text/metadata extraction uses unpdf without provider
credentials. `extractCompleteDocument` also requires a working IMAGE_DESCRIPTION handler
and rejects failed pages rather than presenting partial text as complete. Text-only
helpers do not establish complete visual extraction.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-pdf build  # build
bun run --cwd plugins/plugin-pdf test   # tests
```
