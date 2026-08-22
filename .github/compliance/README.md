# Compliance asset inventory

`asset-inventory.json` is the repository-owned starting point for issue #22870.
It classifies every tracked descriptor in the audit's explicit Cloudflare
Wrangler, Railway, Dockerfile, Compose, Terraform module, Android manifest, and
Apple plist/entitlement classes into an asset boundary. It records required
compliance facts without turning unknown operator facts into healthy defaults.

This Refs-only foundation does not yet discover Kubernetes or general YAML,
Terraform inputs/backends/locks, CI deployment workflows, provider-side
resources, or live environments. Those are explicit follow-on dependencies of
the omnibus issue, not evidence that this bounded registry closes it.

Run:

```bash
bun run audit:compliance-inventory
bun run audit:compliance-inventory:strict
```

The normal audit fails on malformed facts, stale or missing source files,
duplicate ownership, and any newly discovered deployment descriptor that has
not been classified. It writes derived machine-readable and Mermaid/control
ownership views under `reports/compliance/`. Reports are generated evidence and
are not committed.

Every `source-verified` fact, flow, or control must cite tracked, regular asset
descriptors through claim-scoped receipts. Each receipt records one repository
`path`, exactly one `claim`, and non-empty source text in `contains`; the audit
reads the current file, checks every needle, and requires the path or needle to
identify that same claim. The `repository-tracked` and `terraform-managed`
lifecycle claims use typed repository/path checks instead of prose matching.
Fact evidence is confined to that asset's descriptors, each flow endpoint claim
must cite its own endpoint, other flow evidence may cite either endpoint, and
control evidence is confined to registered descriptors. External URLs and
unrelated tracked files are not accepted as source evidence in this bounded
registry; deployed and third-party receipts remain protected operator evidence
until a separately reviewed evidence-ingestion contract exists.

Strict mode additionally fails while any `operator-review-required` hold
remains. Those holds require deployed-environment receipts, account and region
inventory, provider contracts and BAAs, physical/workstation review, retention
and backup proof, and accountable-owner approval. Repository automation cannot
resolve or attest to them.

This initial registry is intentionally not a declaration of HIPAA compliance,
SOC 2 readiness, or permission to process ePHI. Its policy classification keeps
regulated data prohibited until a separately approved regulated-processing
activation supplies the missing contracts and evidence.
