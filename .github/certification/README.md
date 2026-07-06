# Certification trust anchor

`certification-public-key.pem` is the Ed25519 public key that the
develop→main promotion gate trusts. A `certification.json` (produced by
`bun run --cwd packages/evidence certify:sign`) is a signed claim that a
holder of the matching private key reviewed a specific evidence bundle for a
specific commit. Verification logic lives in
`packages/evidence/src/certify/sign.ts`; the CI workflow must stay a thin
caller of `certify:verify` and perform no verification logic of its own
(#14546 / #14547).

**The public key PEM is not committed yet.** The key custodian (repo owner)
generates the production keypair on a trusted machine and lands
`certification-public-key.pem` — recording its fingerprint (first 16 hex of
sha256 over the SPKI DER) here — in a dedicated reviewed PR; merging that PR
is the act of trusting the key. Until it lands, the promotion gate (#14547)
cannot be enabled. There is deliberately no default trust anchor in code:
`certify:verify` requires an explicit `--pubkey`.

## Trust model — binding rules for the CI gate (#14547)

- **Read the public key from the BASE branch (`main`), never from the PR
  head.** The gate must check out `main`'s copy of this file (e.g.
  `git show origin/main:.github/certification/certification-public-key.pem`)
  and pass it via `--pubkey`. If the gate read the key from the PR head, an
  attacker could swap the key and a matching self-signed certification in a
  single PR and the gate would happily verify their own signature. Key
  changes only become trusted after they land on `main` through review.
- **The private key is never in the repo.** It lives only in the
  `ELIZA_CERT_SIGNING_KEY` secret (PEM or base64-wrapped PEM) on the signing
  runner, and in the local env/keychain of authorized certifiers. No tool in
  this repo writes a private key to disk; `certify:keygen` prints it only
  under the explicit `--print-private-key` flag.
- **What a valid signature proves:** a keyholder signed exactly these
  verdicts over exactly this bundle manifest (`bundleSha`) for exactly this
  commit. **What it does not prove:** that the review was diligent. That is
  why the reviewer identity (`{kind, id, model?}`) is part of the signed
  payload and must be surfaced in the gate's check summary.

## Verify contract (what the workflow calls)

```bash
bun run --cwd packages/evidence certify:verify -- \
  --cert <path/to/certification.json> \
  --bundle <bundle-dir> \
  --pubkey <base-branch-checkout>/.github/certification/certification-public-key.pem \
  --expected-commit <pr-head-sha> \
  --max-age-hours 72 \
  --required-tier full \
  [--requirements <requirements.json>] \
  --json
```

Exit 0 iff valid. `--json` prints the full report on stdout, including
`failures: [{code, message, context}]` with distinct codes
(`schema-invalid | unsigned | bad-signature | wrong-key | stale |
commit-mismatch | bundle-tampered | verdict-failures | verdict-incomplete |
tier-insufficient`); all detectable failures are reported together, not
first-failure-only.

For the required develop→main gate, `--bundle` is mandatory. Without the
bundle, verification can only prove that the JSON was signed by the trusted
key; it cannot prove the signed `bundleSha` matches real artifacts, that every
mechanically-derived lane/analysis subject was reviewed, or that verdict
evidence paths actually exist. Omitting `--bundle` is only for detached
signature inspection, never for promotion. With a bundle, verification also
re-runs the mechanical rollup: mechanically non-pass subjects may be signed as
`fail` or `waived` with notes, but never omitted or signed as `pass`.

## Key rotation

1. An authorized engineer runs
   `bun run --cwd packages/evidence certify:keygen -- --print-private-key`
   on a trusted machine (never in CI logs).
2. Open a PR replacing `certification-public-key.pem` and the fingerprint in
   this README. The PR must be reviewed and merged to `main` like any other
   change — merging it is the act of trusting the new key.
3. Update the `ELIZA_CERT_SIGNING_KEY` repo secret (and any local certifier
   copies) to the new private key.
4. Certifications signed by the old key stop verifying the moment the new
   public key is on `main` (`wrong-key`). Re-certify in-flight promotions.

Compromise response is the same procedure, performed immediately; the old
key needs no explicit revocation because the gate trusts exactly one key —
the one on `main`.

## Break-glass (emergencies)

Push to `main` is a production deploy, so the gate must be watertight — but
it must not brick emergencies. The break-glass path is **not a code path**:
a repository admin bypasses the required `certification-verify` check via
branch-protection admin override. Every such bypass is visible in the
GitHub audit log; there is deliberately no in-repo flag, env var, or
alternate verification mode that skips signature checks. #14547 must
document the required-check name it registers so admins know exactly which
check they are bypassing and auditors know what to grep for.
