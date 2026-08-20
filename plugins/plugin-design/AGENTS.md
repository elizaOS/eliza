# @elizaos/plugin-design

Provider-neutral design domain for elizaOS agents: design search, lookup,
node/design export, and comment reads, with local BYO-credential Canva and
Figma adapters.

## Ownership and boundaries

- `DesignService` owns normalized design behavior, adapter registration, and
  the local-versus-managed connection policy.
- `FigmaDesignAdapter` and `CanvaDesignAdapter` map the real provider wire
  formats into the normalized domain. They run only in local mode from
  explicit user-supplied credentials (`FIGMA_PERSONAL_ACCESS_TOKEN`,
  `CANVA_ACCESS_TOKEN`) and never fall back to Cloud silently.
- Managed Cloud OAuth for both providers is eligibility-gated behind human
  provider app registration/review. `MANAGED_DESIGN_ELIGIBILITY` is the
  authoritative ineligible state and `connectManaged` throws
  `DESIGN_MANAGED_MODE_INELIGIBLE`; flipping eligibility is a deliberate code
  change made with approved app credentials custodied in Cloud, never a
  runtime toggle.
- The domain is read/search/export-first. There are no create/edit/delete
  capabilities in this package until provider approval and the managed
  adapter SDK path land.
- Export artifacts carry short-lived provider HTTPS URLs only; bytes are never
  fetched or rehosted here. Attachment ingestion goes through the canonical
  media store when a consumer needs bytes.
- Paid/beta provider limitations surface as typed `DESIGN_PLAN_LIMITED` or
  `DESIGN_UNSUPPORTED` failures, never as fabricated empty results.

## Public surface

- `DesignRef`, `DesignPage`, `DesignExportArtifact`, and `DesignCommentPage`
  are validated normalized types; deep links and thumbnails must be HTTPS and
  Canva links are pinned to `canva.com`.
- `DesignProviderAdapter` is the connector seam. Adapters declare a
  `capabilities` set; deterministic code — never prompt text — selects
  behavior and rejects unsupported capabilities.
- All outbound HTTP flows through `DesignHttpCore`: one pinned origin,
  DNS-pinned SSRF-guarded transport, no redirects, bounded response bytes,
  bounded deadlines, and strict schema decoding.
- Connection handles are opaque (`conn_...`); credentials never appear in
  types, logs, errors, or test fixtures.

## Commands

```bash
bun run --cwd plugins/plugin-design test
bun run --cwd plugins/plugin-design typecheck
bun run --cwd plugins/plugin-design lint:check
bun run --cwd plugins/plugin-design build
```

## Verification

The provider-contract tests drive the real adapters over HTTP against the
repository's protocol-faithful fake upstream speaking Figma and Canva wire
shapes. Keep success, designed-empty, invalid input, pagination (Canva),
rate-limit metadata, malformed/schema-drift responses, expired/revoked/plan
auth distinctions, network failures, SSRF/DNS rebinding, redirects, response
bounds, provider identity binding, opaque connection IDs, redaction, async
export-job lifecycle, and read-policy coverage intact. Live sandbox evidence
against real Figma/Canva accounts is a release gate for promotion, not a CI
requirement.

Follow the root `AGENTS.md` and `CONTRIBUTING.md` evidence requirements.
