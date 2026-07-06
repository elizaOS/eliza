# Certification trust anchor

`certification-public-key.pem` is the Ed25519 public key that the
develop→main promotion gate trusts. A `certification.json` (produced by
`bun run --cwd packages/evidence certify:sign`) is a signed claim that a
holder of the matching private key reviewed a specific evidence bundle for a
specific commit. Verification logic lives in
`packages/evidence/src/certify/sign.ts`; the CI workflow must stay a thin
caller of `certify:verify` and perform no verification logic of its own
(#14546 / #14547).

**Trusted key fingerprint: `3ac9e3e625a9ed2f`** (first 16 hex of sha256 over
the SPKI DER). `packages/evidence/src/certify/committed-key.test.ts` asserts
the committed PEM matches this fingerprint, so an accidental or malicious pem
swap fails the test suite as well as review. This key was provisioned during
the epic #14541 bootstrap; its private half lives in the
`ELIZA_CERT_SIGNING_KEY` repo secret. Rotation (procedure below) is cheap and
may be performed at any time by the repo owner — merging a PR that replaces
the pem and this fingerprint is the act of trusting a new key. There is
deliberately no default trust anchor in code: `certify:verify` requires an
explicit `--pubkey`.

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
  --expected-commit <cert.commit> \
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

## The CI gate (#14547): `certification-verify.yml`

`.github/workflows/certification-verify.yml` runs on every non-draft PR
targeting `main` and is the promotion gate. What it does, in order:

1. Checks out the PR head commit (not the synthetic merge ref) and reads the
   trusted public key from the **base branch** per the trust model above.
2. Locates the certification and bundle: **`certification.json` committed at
   the repo root of the promotion branch** and the signed evidence bundle
   committed at **`evidence/bundle/`**. Missing either file = red, with
   remediation instructions in the check summary. The gate always passes
   `--bundle evidence/bundle` so artifact integrity, rollup completeness, and
   signed evidence-path membership are re-derived from the committed bundle.
3. Runs `scripts/certification/check-commit-drift.mjs`: the certified commit
   must equal the PR head, or be an ancestor whose diff to head touches only
   the docs/template allowlist — `docs/**`, `packages/docs/**`, any `*.md`,
   plus the certification artifacts themselves (`certification.json`,
   `evidence/bundle/**` — those necessarily land after the signed commit and
   are protected by the signature and `bundleSha`, not by the drift rule). Any
   other source, workflow, policy, or config drift = re-certify.
4. Runs `certify:verify` (the contract above) with
   `--expected-commit <cert.commit> --max-age-hours 72 --required-tier full`.
5. Writes a check summary with the reviewer identity, tier, age, signed
   verdict table (waived rows surfaced with notes), drifted paths, trusted
   key fingerprint, and every failure code verbatim. Verification only — the
   gate never performs evidence *review*.

### Branch protection (admins)

Add the required status check **`verify-certification`** (the job name in
`certification-verify.yml`) to `main`'s branch protection. This is a manual
admin step — the workflow does not (and must not) edit branch protection.
Keep the name stable; renaming the job orphans the required check and blocks
every promotion. The companion `certification-verify-selftest` job is CI for
the gate's own plumbing (runs only on PRs touching it) and must **not** be
made a required check.

**Bootstrap:** until this directory's public key and `packages/evidence`
exist on `main`, the gate fails closed on every promotion PR ("no trusted
public key on main"). The first promotion that carries the certification
stack to `main` needs a one-time admin bypass; every promotion after it is
fully gated.

**Residual risk (accepted):** `pull_request`-triggered workflows execute the
PR's own merged workflow definition, so a promotion PR that edits the gate
files could neuter the check. The drift check refuses to allowlist those
paths, the diff is plainly visible to the human merger, and promotion PRs
are human-reviewed by definition. Hardening to `pull_request_target` (base
branch runs the workflow) is a possible follow-up.

### Remediation runbook (gate is red)

1. Preferred: dispatch the vast certification workflow for the promoted
   commit; it produces the bundle, review, and signed `certification.json`.
2. Local fallback (requires a certifier holding `ELIZA_CERT_SIGNING_KEY`):

   ```bash
   bun run --cwd packages/evidence bundle:create -- --tier full
   bun run --cwd packages/evidence certify:rollup -- --bundle <bundle-dir> --out verdicts.json
   # review verdicts.json by hand — waivers require notes
   bun run --cwd packages/evidence certify:sign -- --bundle <bundle-dir> \
     --verdicts verdicts.json --reviewer-id <you> --reviewer-kind human
   cp <bundle-dir>/certification.json ./certification.json  # commit on the promotion branch
   rm -rf evidence/bundle && mkdir -p evidence && cp -R <bundle-dir> evidence/bundle
   ```

3. `stale` (>72h) or `commit-mismatch`/drift failures always mean the same
   thing: re-run certification at the current head. There is no override
   flag by design.

## Break-glass (emergencies)

Push to `main` is a production deploy, so the gate must be watertight — but
it must not brick emergencies. The break-glass path is **not a code path**:
a repository admin bypasses the required `certification-verify` check via
branch-protection admin override. Every such bypass is visible in the
GitHub audit log; there is deliberately no in-repo flag, env var, or
alternate verification mode that skips signature checks. The required check
being bypassed is **`verify-certification`** (see the CI gate section
above) — that is the exact string admins bypass and auditors grep for.
