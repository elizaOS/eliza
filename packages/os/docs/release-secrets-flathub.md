# Maintainer: Flathub credentials

Playbook for the single configurable secret `flatpak-publish.yml` consumes.
Same shape as the apt-repo playbook
([admin-apt-repo-setup.md](./admin-apt-repo-setup.md)): generate → set the repo
secret → sanity-run → rotate/revoke.

`flatpak-publish.yml` opens an update PR against the app's Flathub repo
(`flathub/ai.elizaos.App`): it forks the repo, bumps the manifest `tag` +
`sha256` to the new release tarball, and opens a PR. It runs `gh repo fork` /
`gh pr create` as `GH_TOKEN`.

## Prerequisite — initial Flathub listing (one-time, manual)

Flathub requires a human-reviewed first submission before automated updates
work. The workflow's first step checks `gh repo view flathub/ai.elizaos.App` and
warns + skips everything if the app isn't listed yet.

To get listed:

1. Fork `https://github.com/flathub/flathub`.
2. Add `ai.elizaos.App.yml` (source it from
   `packages/app-core/packaging/flatpak/ai.elizaos.App.store.yml`).
3. Open a PR to `flathub/flathub` — see
   `https://docs.flathub.org/docs/for-app-authors/submission`.
4. After approval the app lives at `https://flathub.org/apps/ai.elizaos.App` and
   the per-app repo `flathub/ai.elizaos.App` exists.

## Secret this workflow reads

| Secret | Required? | Used as |
| --- | --- | --- |
| `FLATHUB_TOKEN` | Optional (falls back to `GITHUB_TOKEN`) | `GH_TOKEN` for the fork checkout + Flathub PR |

`GITHUB_TOKEN` is auto-provided by Actions and is **not** configured. The
workflow uses `${{ secrets.FLATHUB_TOKEN || secrets.GITHUB_TOKEN }}`: without a
`FLATHUB_TOKEN`, it falls back to the auto token, which generally **cannot push
to your Flathub fork** (the fork lives outside this repo). So in practice you
need `FLATHUB_TOKEN` for the PR step to succeed.

## Step 1 — Generate the token (generate fresh)

A GitHub fine-grained PAT owned by the account/org that owns the Flathub fork:

- `https://github.com/settings/tokens?type=beta` → Generate new token
- Resource owner: the account/org that forked `flathub/ai.elizaos.App`
- Repository access: the `ai.elizaos.App` fork repo
- Permissions: **Contents: read and write**, **Pull requests: read and write**
- copy the value → `FLATHUB_TOKEN`

Use a machine/bot account that holds the fork so the token is independent of any
maintainer.

## Step 2 — Set the GitHub secret

Add `FLATHUB_TOKEN` at
`https://github.com/elizaOS/eliza/settings/secrets/actions`.

## Step 3 — Sanity-trigger the workflow

Only meaningful once the app is listed on Flathub (otherwise it warns + skips):

```sh
gh workflow run flatpak-publish.yml \
  --repo elizaOS/eliza \
  --field version=2.0.1 \
  --field tag=v2.0.1
gh run watch --repo elizaOS/eliza
```

A green run forks `flathub/ai.elizaos.App` (if needed), updates the manifest
`tag` + `sha256` for the `v2.0.1` tarball, pushes a `update-to-2.0.1` branch,
and opens a PR against the Flathub repo's `master`. Confirm by finding the new
PR on `flathub/ai.elizaos.App`.

Misconfiguration symptoms:

- `::warning::App not yet listed on Flathub …` → do the initial submission
  first (prerequisite above).
- A `403` on `gh repo fork`/`git push`/`gh pr create` → `FLATHUB_TOKEN` missing
  or lacking Contents/Pull-requests write on the fork (the `GITHUB_TOKEN`
  fallback can't reach the external fork).

## Rotating the token

Generate a replacement fine-grained PAT (Step 1), update the secret, sanity-run.
Then delete the old token at `https://github.com/settings/tokens`.

## Revoking a compromised token

Delete it at `https://github.com/settings/tokens` immediately. The scope is
limited to the Flathub fork repo (with a fine-grained PAT), so the blast radius
is that one repo. Issue a fresh token and update the secret.

## Related

- [release-secrets-checklist.md](./release-secrets-checklist.md) — every secret,
  every channel.
- `flatpak-publish.yml` — the workflow this configures.
