# Maintainer: Homebrew tap credentials

Playbook for the single secret `update-homebrew.yml` consumes. Same shape as
the apt-repo playbook ([admin-apt-repo-setup.md](./admin-apt-repo-setup.md)):
generate → set the repo secret → sanity-run → rotate/revoke.

`update-homebrew.yml` does not build anything. On a published release it fires a
`repository-dispatch` event at the `elizaOS/homebrew-tap` repo (event type
`update-homebrew`, payload `{ "version": "<x.y.z>" }`); the tap repo's own
automation then updates its formula + cask.

## Secret this workflow reads

| Secret | Required? | Used as |
| --- | --- | --- |
| `HOMEBREW_TAP_TOKEN` | Optional (gates the dispatch) | `token` for the `repository-dispatch` action targeting `elizaOS/homebrew-tap` |

The "Check credentials" step warns (`::warning::HOMEBREW_TAP_TOKEN not
configured. Homebrew tap update skipped.`) and skips the dispatch when the
token is empty, so an unconfigured repo doesn't abort the release — it just
doesn't update the tap.

## Step 1 — Generate the token (generate fresh)

`repository-dispatch` needs write access to `elizaOS/homebrew-tap`. Create a
GitHub Personal Access Token from an account that has push access to that repo.

Classic PAT:

- `https://github.com/settings/tokens` → Generate new token (classic)
- scope: `repo`
- copy the value → `HOMEBREW_TAP_TOKEN`

Fine-grained PAT (preferred — least privilege):

- `https://github.com/settings/tokens?type=beta` → Generate new token
- Resource owner: `elizaOS`
- Repository access: only `elizaOS/homebrew-tap`
- Permissions: **Contents: read and write** (the tap automation needs write to
  update the formula). The dispatch itself triggers on the repo; Contents
  write covers it.
- copy the value → `HOMEBREW_TAP_TOKEN`

Prefer a machine/bot account so the token is independent of any one
maintainer's identity.

## Step 2 — Set the GitHub secret

Add `HOMEBREW_TAP_TOKEN` at
`https://github.com/elizaOS/eliza/settings/secrets/actions`.

## Step 3 — Sanity-trigger the workflow

```sh
gh workflow run update-homebrew.yml \
  --repo elizaOS/eliza \
  --field version=2.0.0-beta.0
gh run watch --repo elizaOS/eliza
```

A green run dispatches `update-homebrew` to `elizaOS/homebrew-tap`. Confirm it
landed by checking the tap repo's Actions tab for a freshly-triggered run, then
that the formula/cask version updated.

Misconfiguration symptoms:

- `::warning::HOMEBREW_TAP_TOKEN not configured … skipped` → secret empty.
- A `403`/`404` from the dispatch step → the token lacks write access to
  `elizaOS/homebrew-tap` (wrong account, wrong scope, or expired).

## Rotating the token

PATs can be set to expire. Before expiry: generate a replacement (Step 1),
update the secret, run the sanity dispatch, then delete the old token at
`https://github.com/settings/tokens`.

## Revoking a compromised token

Delete it at `https://github.com/settings/tokens` immediately — the dispatch
stops working at once. Issue a fresh token and update the secret. Because the
token only grants access to the tap repo (with a fine-grained PAT), the blast
radius is limited to that repo.

## Related

- [release-secrets-checklist.md](./release-secrets-checklist.md) — every secret,
  every channel.
- `update-homebrew.yml` — the workflow this configures.
