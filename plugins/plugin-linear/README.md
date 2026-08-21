# @elizaos/plugin-linear

Read-only Linear work-tracking capabilities for Eliza agents over the Linear
GraphQL API. Part of the work-integration migration to native plugin adapters
(epic #19877): the LLM selects provider-neutral read actions and deterministic
code owns credential selection, request construction, and response validation.

## Surface

- `LinearService` — resolves the credential and owns Linear read operations.
- `LinearClient` — bounded, SSRF-guarded GraphQL client pinned to one endpoint.
- `LINEAR` plus promoted `LINEAR_MY_ISSUES`, `LINEAR_SEARCH`, `LINEAR_ISSUE`,
  and `LINEAR_TEAMS` actions, all tagged `domain:work` / `capability:read`.
- `LinearIssue`, `LinearIssuePage`, `LinearTeam`, `LinearViewer` — validated
  public DTOs.

## Credentials

Local/self-hosted BYO mode reads `LINEAR_API_KEY` (sent as a raw
`Authorization` value, matching Linear's personal-key contract). Managed mode
reads `LINEAR_OAUTH_TOKEN` (sent as a `Bearer` value); when both are present
the managed token wins. When neither is configured every operation fails with
a typed `LINEAR_NOT_CONFIGURED` error — there is no silent fallback and no
fabricated-empty result. The credential never appears in URLs, action results,
logs, errors, or model context.

## Transport contract

The client accepts one HTTPS endpoint with no userinfo, query, or fragment,
uses core's DNS-pinned SSRF guard, rejects redirects, and bounds timeout and
response bytes under a single deadline. HTTP status classification stays
authoritative; Linear's GraphQL error envelopes (including auth and rate-limit
failures reported on `400`/`200`) refine classification via `extensions.code`.
A `429` retains `retryAfterMs`; expired (`LINEAR_AUTH_EXPIRED`) and revoked
(`LINEAR_AUTH_REVOKED`) credentials remain distinct failures. Untrusted
response payloads are schema-validated before reaching callers; unknown
workflow-state types are rejected as drift, never coerced.

## Scope

This package is deliberately read-only. Write operations (issue creation,
comments, state changes) arrive incrementally behind the epic's
write-policy/receipt contracts and are not stubbed here.

## Testing

`bun run --cwd plugins/plugin-linear test` runs the in-memory action/service
suite plus the provider-contract conformance lane against the shared
protocol-faithful fake upstream (`@elizaos/cloud-test-mocks/provider-contract`),
covering success, designed-empty, invalid input, pagination, rate limiting,
malformed JSON, schema drift, timeout, connection reset, provider 4xx/5xx,
opaque connection handles, and secret redaction.
