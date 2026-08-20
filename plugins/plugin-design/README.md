# @elizaos/plugin-design

Provider-neutral design capabilities for Eliza agents: search, lookup,
node/design export, and comment reads, backed by local-mode Canva and Figma
adapters.

## Local mode (BYO credentials)

| Setting | Purpose |
| --- | --- |
| `FIGMA_PERSONAL_ACCESS_TOKEN` | Enables the Figma adapter (`X-Figma-Token`). |
| `FIGMA_PROJECT_ID` | Optional numeric project id; enables Figma search by scoping the project file listing. |
| `FIGMA_API_BASE_URL` | Optional origin override for tests or a local desktop bridge. |
| `CANVA_ACCESS_TOKEN` | Enables the Canva Connect adapter (Bearer token from your own Connect integration). |
| `CANVA_API_BASE_URL` | Optional origin override for tests. |

There is no silent Cloud fallback: with no credentials configured, requests
fail with a typed `DESIGN_NOT_CONNECTED` error.

## Managed Cloud mode

Managed OAuth connections for Canva and Figma are gated on provider app
registration and review, which are human-only steps. Until then,
`MANAGED_DESIGN_ELIGIBILITY` reports both providers ineligible and
`DesignService.connectManaged` throws `DESIGN_MANAGED_MODE_INELIGIBLE` with
the runbook reason.

## Capabilities

| Capability | Figma | Canva |
| --- | --- | --- |
| `search` | Project file listing filtered by query (requires `FIGMA_PROJECT_ID`; no pagination) | `/rest/v1/designs` with continuation cursors |
| `get` | `/v1/files/:key` | `/rest/v1/designs/:id` |
| `export` | `/v1/images/:key` node renders (nodeId required) | Async export job create + bounded polling (`svg` unsupported) |
| `comments` | `/v1/files/:key/comments` | Unsupported until the Comment API beta capability is granted |

Exports return short-lived provider HTTPS URLs; bytes are never rehosted by
this package. Paid/beta limitations surface as `DESIGN_PLAN_LIMITED` or
`DESIGN_UNSUPPORTED`.

## Testing

```bash
bun run --cwd plugins/plugin-design test
```

The contract suites run the real adapters over HTTP against the repository's
protocol-faithful fake provider upstream, covering the full outbound-http
conformance matrix plus auth-state distinctions, the Canva export-job
lifecycle, SSRF/redirect/byte-bound defenses, and provider identity binding.
