# Alpha agent on dstack

Reproducible deployment of a fresh Eliza agent in a dstack CVM (#31018, #31328).
Text runs on Cerebras; embeddings and speech use Eliza Cloud or an
OpenAI-compatible endpoint. Local models are disabled. Ingress uses the agent's
`ELIZA_API_TOKEN`.

Keep every operator file in one private directory outside the repository
(`$D`). That includes the release authority key, `secrets.json` and all outputs.
Nothing secret is committed, rendered into compose or printed.

## Inputs

- `$D/deployment.json`: copy `deployment.example.json` and fill in the agent ID,
  dstack OS image hash, KMS/VMM endpoints and pins, and the stable `publicOrigin`
  (the phone APK pins this origin).
- `$D/authority.pem` and `$D/authority.pub.pem`: Ed25519 release authority.
- `$D/secrets.json` (mode 0600): `CEREBRAS_API_KEY`, `ELIZAOS_CLOUD_API_KEY`,
  `ELIZA_API_TOKEN` and `ELIZA_VAULT_PASSPHRASE` (each at least 32 characters),
  plus `EMBEDDING_API_KEY` for OpenAI-compatible embeddings.

## Deploy

```bash
C="bun --conditions=eliza-source packages/app/scripts/alpha-dstack.ts"
bash packages/app/deploy/dstack-alpha/build-image.sh --registry ghcr.io/<org>/eliza-alpha --out $D
$C render --deployment $D/deployment.json --image $D/image.json --authority-pub $D/authority.pub.pem --out $D/r1
bun packages/app/scripts/sign-confidential-release.ts --input $D/r1/release.json --key $D/authority.pem --output $D/r1/release.envelope.json
$C encrypt-env --deployment $D/deployment.json --out-dir $D/r1 --secrets $D/secrets.json --authority-pub $D/authority.pub.pem --launch-key $D/authority.pem
$C sign-processors --deployment $D/deployment.json --out-dir $D/r1 --key $D/authority.pem --revision r1
$C provision-request --deployment $D/deployment.json --out-dir $D/r1
DSTACK_VMM_AUTHORIZATION=... bun packages/app/scripts/provision-confidential-vm.ts --input $D/r1/provision-request.json --authority $D/authority.pub.pem
```

`build-image.sh` builds `Dockerfile.ci` from digest-pinned bases in
`image.lock.json` for `linux/amd64`, adds the pinned `dstack-verifier` and pushes
the image. Compose references it by registry digest. `render` writes the exact
`app-compose.json` bytes. Its hash is the dstack compose hash and app ID.
Provisioning creates a stopped VM; start it with the VMM, then route
`publicOrigin` to gateway port 2138.

The compose uses a persistent `eliza-state` volume at `/data/eliza`,
`restart: unless-stopped` and an `/api/health` check. `confidential-bootstrap.mjs`
authenticates the encrypted launch variables against the signed release before
the agent loads. The agent then admits itself through the `dstack-cpu` boot gate.

The environment also seeds the `alpha-routines` pack (morning brief, reminders,
nudge) in a disabled state. After the owner's timezone is set, enable a routine
by posting its `metadata.enableTrigger` as the new `trigger` to
`POST /api/lifeops/scheduled-tasks/:id/edit`. If onboarding later links Eliza
Cloud, the agent config's service routing overrides these environment
defaults. Keep text on Cerebras and speech on Cloud.

## Verify and pair

```bash
export ELIZA_ALPHA_API_TOKEN=...   # the ELIZA_API_TOKEN from secrets.json
$C verify-attestation --deployment $D/deployment.json --image $D/image.json --out-dir $D/r1 \
  --authority-pub $D/authority.pub.pem --verifier /abs/dstack-verifier --verifier-config /abs/dstack-verifier.toml \
  --endpoint https://alpha-agent.example.com
$C pair-link --endpoint https://alpha-agent.example.com | qrencode -t ansiutf8
```

Verification needs the same `dstack-verifier` binary and config as the image
(`image.json` pins their digests), on Linux x86-64. It sends a fresh nonce and
appraises the raw evidence against the signed release, compose, OS image and
processor policy. It fails on any mismatch, debug platform, stale TCB or
replayed challenge.

`pair-link` prints a single-use `elizaos://remote/agent-pair` link that carries
no token. The phone app must trust `publicOrigin`; build it with
`VITE_ELIZA_REMOTE_FALLBACK_API_BASE=<publicOrigin>`.

## Upgrade and rollback

Every release gets a new compose hash, and therefore a new app ID and CVM disk.
Keep each release directory (`$D/r1`, `$D/r2`, …) and never delete the previous
VM before the new one is verified.

1. Before cutover, back up the running agent: `POST /api/snapshot` with the API
   token, stored in `$D`.
2. Provision and verify the new release, then move `publicOrigin` to it.
3. To roll back, stop the new VM, start the previous VM and move `publicOrigin`
   back. The previous VM resumes with its own state as of cutover. Data written
   after cutover exists only in the new VM or the snapshot.
