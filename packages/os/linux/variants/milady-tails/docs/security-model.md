# elizaOS Live Security Model

This document defines the production security boundary for the elizaOS Live
Tails-derived image. It is intentionally phrased as policy that can be checked
by `scripts/security-smoke.sh`, not as aspirational product copy.

## Trust Boundaries

elizaOS Live has five production trust boundaries:

- **Live root filesystem:** the ISO SquashFS and boot artifacts are read-only
  release artifacts. They are activated only after release signature and
  checksum verification.
- **Live user session:** the app, renderer, agent, and normal desktop run as
  the `amnesia` user. They do not receive direct root, unrestricted sudo, or
  broad polkit authority.
- **Capability broker:** privileged elizaOS operations cross into root only
  through `/usr/local/lib/elizaos/capability-runner` and its generated sudoers
  allowlist.
- **Persistent Storage:** user state, app state, models, credentials, and
  app/runtime updates are stored only in Tails encrypted Persistent Storage
  after the user unlocks it.
- **Release/update pipeline:** ISO, app/runtime bundles, model catalogs, OS
  deltas, policy bundles, SBOM, and provenance are promoted only through signed
  manifests.

Failure policy is conservative: if policy state is missing, malformed, or not
yet implemented, elizaOS Live must choose the safer mode or refuse activation.

## Capability Broker Boundary

The app must never gain general root. The only elizaOS-owned sudoers entry is:

```text
amnesia -> /usr/local/lib/elizaos/capability-runner root-status
```

Current broker commands are:

- `status`: unprivileged OS/app status
- `privacy-mode`: unprivileged privacy-mode state
- `open-persistent-storage`: user-session helper for the Tails Persistent
  Storage UI
- `root-status`: exact root smoke command proving the sudoers path is narrow

Production policy:

- no `ALL`, shell, package-manager, service-manager, network-manager, device
  writer, or arbitrary-argument sudo rule may be added for elizaOS
- every future root command gets a command name, exact executable path, exact
  argument schema, user-facing approval requirement, and audit event
- broker failures return non-zero and leave state unchanged
- broker logs must not include prompts, secrets, tokens, model inputs, or file
  contents

Inherited Tails sudoers rules are reviewed in
[`inherited-tails-sudoers-review.md`](./inherited-tails-sudoers-review.md).
They are accepted only as inherited Tails feature plumbing for Greeter,
Persistent Storage, Tor Browser, Tails Upgrader, and WhisperBack. elizaOS
policy must not add new broad rules on top of them.

## Persistence Boundary

Amnesia mode is the default. In amnesia mode:

- elizaOS state is under `/home/amnesia` tmpfs and disappears at shutdown
- downloaded models, app updates, credentials, and workspace files are not
  durable
- app/runtime update activation is either refused or explicitly RAM-only for
  that session

Persistent mode is opt-in and uses Tails Persistent Storage. The elizaOS
feature owns only these bindings:

- `/home/amnesia/.eliza`
- `/home/amnesia/.milady`
- `/home/amnesia/.config/elizaOS`
- `/home/amnesia/.config/milady`
- `/home/amnesia/.config/Milady`
- `/home/amnesia/.cache/ai.elizaos.app`
- `/home/amnesia/.cache/ai.milady.milady`

Production policy:

- no elizaOS persistence binding may target `/home/amnesia` wholesale,
  `/etc`, `/usr`, `/var`, `/root`, `/opt`, or an unencrypted external path
- persistence activation/deactivation must quiesce elizaOS units before
  switching bind mounts
- cleanup hooks may delete only bounded runtime cache directories under the
  elizaOS-owned paths and must use `find -P -xdev`
- migrations must be versioned, reversible where possible, and tested across
  rollback

## Update Signing and Recovery

The current branch contains the app/runtime verifier foundation, not the full
production updater. OS/base updates still require a new signed ISO and a
guarded writer until the OS delta path is implemented. Production update
activation requires:

- release manifest signed by the elizaOS release key
- artifact digest and size checks before activation
- channel/ring, version, architecture, and product checks
- rollback target: read-only ISO bundle, previous active app bundle, previous
  model version, or full-image recovery
- fail-closed behavior for missing manifest, bad signature, wrong ring, wrong
  product, wrong hash, partial download, failed migration, or missing rollback
- no execution from user-writable staging paths; verified app runtimes must be
  materialized into a root-owned store first

Current audit caveat: the verifier materializes signed runtimes into a
root-owned store with no-symlink checks and copy-time rehashing, but the
production updater still needs release keys, revocation metadata, downloader
UX, rollback tests, and a stronger promotion token/root-owned health handoff
before it should be marketed as a stable update channel.

The Tails IUK stack already contains signed upgrade-description and target-file
checks. elizaOS must not bypass that path for OS deltas. App/runtime manifests
now have a schema and verifier. Stable release still needs production keys,
revocation metadata, downloader/staging UX, model artifact verification,
rollback health policy, and signed release evidence.

## SBOM and Provenance

Every stable release must publish:

- OS package SBOM from the live-build package manifest
- bundled app/runtime SBOM
- model catalog manifest with hashes, source, license, and safety notes
- license/CREDITS bundle, including Tails attribution
- provenance statement naming source commit, build container digest, builder,
  build time, artifact hashes, and signing key ID

Promotion gates:

- no stable artifact without SBOM and license bundle
- no enterprise artifact without provenance and release approval evidence
- no unsigned nightly artifact may be presented as safe for secrets

## Root and User Service Constraints

System-level elizaOS service policy:

- root-owned supervisor only starts/restarts user services
- `NoNewPrivileges=yes`
- `PrivateTmp=yes`
- `ProtectSystem=full` or stricter
- no writable broad filesystem paths
- no direct app runtime as root

User-level elizaOS service policy:

- `ConditionUser=1000`
- `NoNewPrivileges=yes`
- loopback-only agent/renderer bind addresses
- fixed app ports unless explicitly changed through validated config
- no dependency on Tails `desktop.target` or Tor bootstrap for normal mode
- no user-owned systemd override can replace elizaOS units across persistence

Production hardening still needed: AppArmor profile coverage for the elizaOS
agent/browser surface, tighter systemd sandboxing for user services, polkit
review, and a decision on renderer sandbox posture.

## Checked Policy

Run the cheap security smoke from the variant root:

```sh
scripts/security-smoke.sh
```

For release candidates, run strict mode:

```sh
ELIZAOS_SECURITY_STRICT=1 scripts/security-smoke.sh
```

Default mode fails on elizaOS-owned policy violations and reports inherited or
not-yet-implemented production blockers as warnings. Strict mode fails on those
blockers too.
