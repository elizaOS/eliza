# Maintainer: Snap Store credentials

Playbook for the single secret `snap-publish.yml` consumes. Same shape as the
apt-repo playbook ([admin-apt-repo-setup.md](./admin-apt-repo-setup.md)):
generate → set the repo secret → sanity-run → rotate/revoke.

`snap-publish.yml` builds, installs, boots, and publishes the real snap only
after its Store credential passes validation. An enabled publishing run with
no credential fails before build, so the release orchestrator cannot mistake a
CI-only artifact for a Store publication.

`publish-packages.yml` calls this reusable workflow for automatic
post-publication distribution; it does not carry a second inline Snap build.
Manual recovery uses the same implementation. The shared `snap-publish`
concurrency group serializes every channel so retries cannot race the release
run or create divergent revisions for one tag.

## External FFmpeg connection gate

The `ffmpeg-2204` content provider is published by Snapcrafters, not by the
publisher of `elizaos-app`. `default-provider` installs that provider but does
not grant a cross-publisher connection. Until the Snap Store approves an
auto-connect request and a clean post-publication install proves the connection,
users must run:

```sh
sudo snap install ffmpeg-2204
sudo snap install elizaos-app
sudo snap connect elizaos-app:ffmpeg-2204 ffmpeg-2204:ffmpeg-2204
```

The CI build lanes deliberately connect the plug and assert the resulting
`snap connections` row before their H.264 smoke. That proves the explicit
contract, not Store auto-connect. Requesting, receiving, and verifying Store
auto-connect remains an external release blocker for a one-command install.

## Prerequisite — register the snap name (one-time)

Before the first publish, claim the snap name from a machine with snapcraft:

```sh
snapcraft login
snapcraft register elizaos-app
snap info elizaos-app
```

The workflow's `snapcraft.yaml` lives at
`packages/app-core/packaging/snap/snapcraft.yaml`; the registered name must
match it. The public Store lookup currently reports no published
`elizaos-app`, so the maintainer must reserve and confirm the name before
minting the CI credential. CI does not receive `package_register` authority.

## Secret this workflow reads

| Secret | Required? | Used as |
| --- | --- | --- |
| `SNAPCRAFT_STORE_CREDENTIALS` | Required when Snap publishing is enabled | `SNAPCRAFT_STORE_CREDENTIALS` env consumed by the pinned publish action |

The "Check Snap Store credentials" step emits an Actions error and exits when
the secret is empty.

## Step 1 — Export the store credential (generate fresh)

`snapcraft export-login` mints a CI token scoped to the exact operations and
channels used by the pinned publish action. Run it on a machine where you're
logged in to the Snap Store:

```sh
snapcraft export-login \
  --snaps elizaos-app \
  --channels edge,beta,candidate,stable \
  --acls package_access,package_push,package_update,package_release \
  --expires "2030-01-01T00:00:00" \
  snap-store-credentials.txt
cat snap-store-credentials.txt
```

The file contents (the exported login blob) → `SNAPCRAFT_STORE_CREDENTIALS`.

Scope it to the `elizaos-app` snap, the four workflow channels, and only the
access/push/update/release ACLs the publish action needs. Set an expiry so a
leaked token dies on its own.

## Step 2 — Set the GitHub secret

Add `SNAPCRAFT_STORE_CREDENTIALS` at
`https://github.com/elizaOS/eliza/settings/secrets/actions`, then delete the
local file:

```sh
shred -u snap-store-credentials.txt
```

## Step 3 — Sanity-trigger the workflow

```sh
gh workflow run snap-publish.yml \
  --repo elizaOS/eliza \
  --field version=2.0.1 \
  --field tag=v2.0.1 \
  --field channel=edge
gh run watch --repo elizaOS/eliza
```

Use `channel=edge` for the sanity run so you don't push to `stable`. A green
run builds and boot-tests the snap, publishes it to `edge`, and uploads the CI
artifact.

Misconfiguration symptoms:

- `::error::Snap publishing is enabled but SNAPCRAFT_STORE_CREDENTIALS is unavailable`
  → the required repository secret is empty or unavailable to the caller.
- An auth error from the publish action → the credential expired, lacks one of
  `package_access`, `package_push`, `package_update`, or `package_release`, or
  was minted for a different snap name/channel.

## Rotating the credential

Re-run `snapcraft export-login` with a new expiry (Step 1), update the secret,
sanity-run on `edge`. The Snap Store can have multiple valid exported logins, so
there's no hard cutover; just stop using the old one.

## Revoking a compromised credential

Revoke it from the Snap Store dashboard (`https://snapcraft.io/account` →
your developer account → credentials) or by changing the account password,
which invalidates exported logins. Then mint and set a fresh credential.

## Related

- [release-secrets-checklist.md](./release-secrets-checklist.md) — every secret,
  every channel.
- `snap-publish.yml` — the workflow this configures.
