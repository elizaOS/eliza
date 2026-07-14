# Admin: enable the apt-repo publish path

This is the maintainer playbook for turning on signed apt-repo
publishing for elizaOS Live. It's a one-time setup per repo. Once configured,
the post-publication `release-orchestrator.yml` → `publish-packages.yml` path
attaches one verified `.deb` and invokes `publish-apt-repo.yml` to update this
repo's `apt-repo` branch.

The reusable-workflow declarations remain optional so configuration errors
produce job logs. An enabled apt publishing run fails at its credential gate
when the signing identity is unavailable or ambiguous.

## What you need

- Admin access to https://github.com/elizaOS/eliza/settings/secrets/actions
- A GPG key that signs the apt repo's `Release` file. Either generate
  a new one (preferred — dedicated key for this job; revocable
  independently of any personal key) or reuse an existing org key.
- ~10 minutes.

## Step 1 — Generate a dedicated GPG key

Don't use a personal key. The CI runs unattended; if the key gets
exposed you want to revoke just this one, not your whole identity.
Generate it on a trusted machine (not the GitHub runner):

```sh
gpg --batch --quick-generate-key \
    'elizaOS apt-repo signing <ci@elizaos.ai>' \
    rsa4096 sign 2y
```

Confirm it landed:

```sh
gpg --with-colons --fingerprint \
  'elizaOS apt-repo signing <ci@elizaos.ai>' |
  awk -F: '$1 == "fpr" { print $10; exit }'
# 0123456789ABCDEF0123456789ABCDEF01234567
```

Record the complete 40-hex **primary-key fingerprint** and set it as
`DEBIAN_GPG_KEY_ID`. Short and long key IDs are intentionally rejected because
they do not bind the publisher to one exact primary key.

Optionally set a passphrase. The workflow handles both:

- No passphrase → leave `DEBIAN_GPG_PASSPHRASE` unset.
- Passphrase set → also set the `DEBIAN_GPG_PASSPHRASE` secret.

In both cases the workflow performs a loopback detached-signature probe before
`reprepro`. The probe validates the credential and primes the isolated GPG
agent without an interactive pinentry. It deliberately does not use
`reprepro --ask-passphrase`, whose prompt does not consume the piped secret.

## Step 2 — Export the private key for CI

CI needs the ASCII-armored private key (so it can be stored as a GitHub
secret string):

```sh
gpg --armor --export-secret-keys \
  "0123456789ABCDEF0123456789ABCDEF01234567" \
  > /tmp/elizaos-apt-private.asc
```

Verify it round-trips (must be importable as an exact reverse):

```sh
gpg --batch --import < /tmp/elizaos-apt-private.asc
# expected: "gpg: secret key imported"
```

The file is now sensitive — handle it once, paste it once, then delete:

```sh
shred -u /tmp/elizaos-apt-private.asc
```

## Step 3 — Set the GitHub secrets

In https://github.com/elizaOS/eliza/settings/secrets/actions click
"New repository secret" for each of:

| Secret name | Value | Required? |
| --- | --- | --- |
| `DEBIAN_GPG_PRIVATE_KEY` | The full contents of the ASCII-armored private key from Step 2 (the whole `-----BEGIN PGP PRIVATE KEY BLOCK-----` block, newlines preserved) | Yes — sign-blocking |
| `DEBIAN_GPG_KEY_ID` | The exact 40-hex primary-key fingerprint from Step 1 | Yes — sign-blocking |
| `DEBIAN_GPG_PASSPHRASE` | Passphrase if you set one in Step 1; leave the secret unset otherwise | Optional |

Both required secrets must be set together. The workflow's credential gate
fails if either is missing, if the fingerprint is not exactly 40 hex
characters, or if the armored import contains a different or additional
primary key.

Org-level secrets work too — set them under
https://github.com/organizations/elizaOS/settings/secrets/actions if
you want to share the key across multiple repos.

## Step 4 — Sanity-trigger the workflow

Run `publish-apt-repo.yml` manually once to confirm everything is
wired:

```sh
gh workflow run publish-apt-repo.yml \
    --repo elizaOS/eliza \
    --field version=2.0.3 \
    --field tag=v2.0.3 \
    --field channel=stable
```

Watch:

```sh
gh run watch --repo elizaOS/eliza
```

A green run will:

1. Print `can_publish=true` from the `Check GPG credentials` step.
2. Create the `apt-repo` branch at a real empty-root commit if it doesn't exist.
3. Download the `.deb` from the release tag.
4. Validate and unlock the exact signing key with the loopback signing probe.
5. Add the package with `reprepro`, or verify an existing same-version package
   is byte-identical on an idempotent retry.
6. Re-export signed repository metadata for every configured distribution,
   including on an identical retry.
7. Commit + push the updated `apt-repo` branch.

A red run with `APT publishing is enabled but DEBIAN_GPG_PRIVATE_KEY is
unavailable` means the secret wasn't set. Re-check Step 3.

## Step 5 — Configure and prove the public boundary

The only automated repository writer is the in-repo
`release-orchestrator.yml` → `publish-packages.yml` → `publish-apt-repo.yml`
path. It commits to this repository's `apt-repo` branch and exports the
selected public key as `gpg.key`. Standalone Debian builds are reusable/manual
validation lanes and do not attach a release asset; `release-all.yml` and
`elizaos-os-full-release.yml` do not start competing Debian or APT producers.
There is no external repository dispatch or token.

Configure GitHub Pages to serve the `apt-repo` branch, then create and verify
the `apt.elizaos.ai` DNS record under an owner-controlled zone. The hostname
currently has no DNS record, so this is a release blocker rather than an
already-proven channel. Verify `gpg.key`, `InRelease`, `Release.gpg`, and the
stable/beta `Packages` indexes over HTTPS, then install through apt on a clean
supported host. A successful branch push by itself is not distribution
evidence.

## Rotating the key

Keys expire (default 2 years in Step 1). Rotation is the reverse of
setup: generate a new key with the same uid, update the three secrets,
trigger a manual run, then republish the public key.

Sign the old key with the new key first so users can pick up the
transition without re-trusting from scratch:

```sh
# In offline trust context
gpg --sign-key "NEW_KEY_ID"
gpg --armor --export "NEW_KEY_ID" > new-public.asc
```

## Revoking a compromised key

If the private key leaks:

1. Generate a revocation certificate immediately:
   ```sh
   gpg --output revoke-OLD_KEY_ID.asc --gen-revoke OLD_KEY_ID
   ```
2. Import + export the revoked key:
   ```sh
   gpg --import revoke-OLD_KEY_ID.asc
   gpg --armor --export OLD_KEY_ID > revoked-public.asc
   ```
3. Publish `revoked-public.asc` to the same location as the previous
   public key file so existing apt clients refresh trust.
4. Repeat Steps 1-5 above with a fresh key.

## Related

- [packages/os/docs/ci-cd-production-plan.md](./ci-cd-production-plan.md) —
  broader release pipeline status.
- [packages/os/docs/verify-iso-download.md](./verify-iso-download.md)
  — end-user side of the same release pipeline (ISO verification, not
  apt-repo).
- [reprepro docs](https://salsa.debian.org/brlink/reprepro) — the
  tool the workflow uses to actually maintain the apt repo.
