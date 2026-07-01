# Maintainer: Snap Store credentials

Playbook for the single secret `snap-publish.yml` consumes. Same shape as the
apt-repo playbook ([admin-apt-repo-setup.md](./admin-apt-repo-setup.md)):
generate → set the repo secret → sanity-run → rotate/revoke.

`snap-publish.yml` always **builds** the snap (`snapcraft --destructive-mode`)
and uploads it as a CI artifact. The Store upload (`snapcraft upload --release
<channel>`) only runs when the credential is present, so an unconfigured repo
still produces a `.snap` to inspect.

## Prerequisite — register the snap name (one-time)

Before the first publish, claim the snap name from a machine with snapcraft:

```sh
snapcraft login
snapcraft register elizaos-app
```

The workflow's `snapcraft.yaml` lives at
`packages/app-core/packaging/snap/snapcraft.yaml`; the registered name must
match it.

## Secret this workflow reads

| Secret | Required? | Used as |
| --- | --- | --- |
| `SNAPCRAFT_STORE_CREDENTIALS` | Optional (gates the Store upload) | `SNAPCRAFT_STORE_CREDENTIALS` env consumed by `snapcraft upload` |

The "Check Snap Store credentials" step warns (`::warning::SNAPCRAFT_STORE_CREDENTIALS
not configured. Snap build will run but Store upload will be skipped.`) and
skips the upload when empty.

## Step 1 — Export the store credential (generate fresh)

`snapcraft export-login` mints a CI token scoped to the upload ACLs. Run it on a
machine where you're logged in to the Snap Store:

```sh
snapcraft export-login \
  --snaps elizaos-app \
  --acls package_upload,package_push,package_register \
  --expires "2030-01-01T00:00:00" \
  snap-store-credentials.txt
cat snap-store-credentials.txt
```

The file contents (the exported login blob) → `SNAPCRAFT_STORE_CREDENTIALS`.

Scope it to the `elizaos-app` snap and only the upload ACLs so the credential
can't do more than publish this one snap. Set an expiry so a leaked token dies
on its own.

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
run builds the snap, uploads the CI artifact, and (with the credential set)
runs `snapcraft upload elizaos-app_*.snap --release edge`.

Misconfiguration symptoms:

- `::warning::SNAPCRAFT_STORE_CREDENTIALS not configured …` → secret empty (the
  `.snap` artifact still attaches; only the Store push is skipped).
- An auth error from `snapcraft upload` → the credential expired or lacks the
  `package_upload`/`package_push` ACLs, or was minted for a different snap name.

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
