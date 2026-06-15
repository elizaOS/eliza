# Admin: enable the apt-repo publish path

This is the maintainer playbook for turning on signed apt-repo
publishing for elizaOS Live. It's a one-time setup per repo. After
this lands the `publish-apt-repo.yml` workflow stops skipping (see
PR #7976) and every release tag publishes a signed `.deb` to the
`apt-repo` branch of this repo.

Status today (2026-05-25): the workflow has `required: false` on its
GPG secrets so it emits a clean warning and skips when the secrets
aren't present. Configure them per below to flip publishing on.

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
gpg --list-secret-keys --with-colons | grep '^sec' | head -1
# sec:u:4096:1:<KEY_ID_HEX>:<created>:<expires>:::...
```

Record the **key id** — the 16-char hex after the third colon. You'll
set it as `DEBIAN_GPG_KEY_ID`. Example: `1A2B3C4D5E6F7890`.

Optionally set a passphrase. The workflow handles both:

- No passphrase → leave `DEBIAN_GPG_PASSPHRASE` unset, `reprepro` runs
  without `--ask-passphrase`.
- Passphrase set → also set `DEBIAN_GPG_PASSPHRASE` secret; the
  workflow pipes it to `reprepro --ask-passphrase`.

## Step 2 — Export the private key for CI

CI needs the ASCII-armored private key (so it can be stored as a GitHub
secret string):

```sh
gpg --armor --export-secret-keys "1A2B3C4D5E6F7890" > /tmp/elizaos-apt-private.asc
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
| `DEBIAN_GPG_KEY_ID` | The 16-char hex key id from Step 1 | Yes — sign-blocking |
| `DEBIAN_GPG_PASSPHRASE` | Passphrase if you set one in Step 1; leave the secret unset otherwise | Optional |

Both required secrets must be set together. The workflow's
`Check GPG credentials` step (see PR #7976) skips publishing with a
clear warning if either is missing, so a half-configured repo doesn't
silently produce an unsigned apt repo.

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
2. Create the `apt-repo` branch as an orphan if it doesn't exist.
3. Download the `.deb` from the release tag.
4. Run `reprepro includedeb` to add the package.
5. Commit + push the updated `apt-repo` branch.

A red run with a clear warning ("DEBIAN_GPG_PRIVATE_KEY not configured")
means the secret wasn't set. Re-check Step 3.

## Step 5 — Publish the public key

End users who add the apt repo need the matching public key. Export it
ASCII-armored:

```sh
gpg --armor --export "1A2B3C4D5E6F7890" > /tmp/elizaos-apt-public.asc
```

Commit it to a publicly-readable location — recommended:
`packages/os/release/apt-repo/elizaos-apt-public.asc` in the main
branch. That's stable, version-controlled, and discoverable.

Document the user-side install in your release notes:

```sh
# Trust the elizaOS apt-repo signing key
curl -fsSL https://raw.githubusercontent.com/elizaOS/eliza/main/packages/os/release/apt-repo/elizaos-apt-public.asc \
    | sudo tee /etc/apt/trusted.gpg.d/elizaos.asc > /dev/null

# Add the repo
echo "deb https://elizaos.github.io/eliza/apt-repo stable main" \
    | sudo tee /etc/apt/sources.list.d/elizaos.list

# Install
sudo apt update
sudo apt install elizaos-app
```

(Substitute the actual `apt-repo` branch URL — GitHub Pages serves it
automatically if you enable Pages → "Deploy from a branch: apt-repo".)

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

- PR #7976 (this PR's prerequisite) — makes the secrets optional in
  `publish-apt-repo.yml` so a fresh repo doesn't startup_failure
  before this admin work is done.
- [packages/os/docs/ci-cd-production-plan.md](./ci-cd-production-plan.md) —
  broader release pipeline status.
- [packages/os/docs/verify-iso-download.md](./verify-iso-download.md)
  — end-user side of the same release pipeline (ISO verification, not
  apt-repo).
- [reprepro docs](https://salsa.debian.org/brlink/reprepro) — the
  tool the workflow uses to actually maintain the apt repo.
