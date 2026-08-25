# Certification assets

This directory contains two related certification controls:

- the evidence-package trust anchor described below; and
- the public, redacted [staging resource ledger](./staging-resources.yaml), its
  [JSON Schema](./staging-resources.schema.json), and its generated
  [review view](./staging-resources.md).

The YAML ledger is the staging-resource authority. The JSON Schema validates
its structure; canonical coverage, graph, privacy, freshness, and readiness
semantics live in the checker. The Markdown file is a generated review aid,
not an alternative source of truth. Validate all three files with:

```bash
bun run test:launch-qa:staging-resources
```

After an intentional contract change, regenerate the schema and review view,
then run the validator again:

```bash
node packages/scripts/launch-qa/check-staging-resource-ledger.mjs \
  --write-schema --write-view
bun run test:launch-qa:staging-resources
```

## Public/private boundary

The committed ledger contains only opaque `qar-*` resource references,
controlled vocabulary, names-only environment-variable references, redacted
states, opaque receipt references, source commits, issue numbers, and an
optional public Ed25519 readiness authorization. A separately approved private
resolver maps those references to real provider objects and custodians. The
resolver is required for operations but is never committed or named here.

An opaque receipt string is not proof by itself. Any `READY` claim must be
covered by a valid, short-lived signature from the trust anchor below; with no
READY rows, `ready_authorization` must remain `null`. The signature certifies
the complete public redacted claim after an operator reviews the private
evidence—it never publishes or replaces that evidence.

Never add an email address, phone number, provider/user/chat identifier,
account alias, wallet address, token fragment, OTP, recovery material, private
secret-store locator, message content, or private evidence path. Local source
fixtures and README files are not provider-backed evidence. The full operating
contract is in
[Staging resource ledger operations](../../docs/testing/staging-resource-ledger.md).

## Certification trust anchor

`certification-public-key.pem` is the Ed25519 public key used by the evidence
package tools and staging-resource readiness authorizations. Its trusted
fingerprint is `3ac9e3e625a9ed2f` (the first 16 hexadecimal characters of the
SHA-256 digest of the SPKI DER).

The repository no longer runs a dedicated certification workflow. Evidence
certification is an operator-run release/review activity:

```bash
bun run --cwd packages/evidence certify:verify -- \
  --cert <path/to/certification.json> \
  --bundle <bundle-dir> \
  --pubkey .github/certification/certification-public-key.pem \
  --expected-commit <commit> \
  --required-tier full \
  --json
```

The private key must never be committed. To rotate trust, generate a new key,
replace the PEM and fingerprint in the same reviewed change, then update the
operator-held private key.
