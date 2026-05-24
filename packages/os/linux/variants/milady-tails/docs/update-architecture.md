# elizaOS Live update architecture

This slice adds the production update foundation for app/runtime updates
without adding a network downloader or ISO/IUK builder. It is a checked
prototype: release keys, downloader UX, revocation service, and full rollback
policy are still production work.

## Goals

- Keep `/opt/milady` as the immutable factory runtime baked into the ISO.
- Allow an unlocked Persistent Storage to stage an app/runtime bundle.
- Trust staged updates only after root verifies a detached signature, a
  complete file inventory, and all declared hashes on every boot.
- Materialize verified runtimes into a root-owned store before execution; do
  not execute directly from user-writable staging paths.
- Write trusted runtime selection into `/run/elizaos`, not into user-writable
  marker files.
- Provide a model catalog contract that can be updated with the runtime
  manifest but does not execute code.

## Non-goals

- No network download path.
- No installer execution or arbitrary activation hooks.
- No arbitrary payload hooks.
- No ISO, IUK, or heavy build jobs.

## On-disk layout

The verifier consumes this staged layout:

```text
/home/amnesia/.eliza/updates/
  channel                         # optional user preference, path-safe name
  channels/
    stable/
      manifest.json
      manifest.json.sig
      runtime-2026.05.17/
        bin/bun
        bin/launcher
        Resources/app/eliza-dist/entry.js
        Resources/app/eliza-dist/node_modules/...
      model-catalog.json
  state/
    ...                           # legacy user hints are ignored for trust

/live/persistence/TailsData_unlocked/elizaos-system/
  runtimes/<manifest-sha256>/     # root-owned materialized runtime store
  update-state/
    good/<manifest-sha256>        # root-owned post-health marker
    rejected/<manifest-sha256>    # root-owned rollback marker
    sequence-floor/<channel>      # root-owned anti-rollback floor after good
```

The user-writable staging directory never establishes trust. The selected
`manifest.json` must pass signature verification and full inventory/hash
verification, then root copies the declared runtime into the root-owned
materialized store. Launcher state points at the materialized copy, not the
staged source tree.

## Trust model

`/usr/local/lib/elizaos/update-manager verify` is the root verifier. It fails
closed to `/opt/milady` unless all checks pass:

1. `gpgv` is available.
2. A trusted public keyring exists at one of:
   - `$ELIZAOS_UPDATE_KEYRING`
   - `/usr/share/keyrings/elizaos-update.gpg`
   - `/etc/elizaos/update-keyring.gpg`
   - `/usr/local/share/elizaos/update-keyring.gpg`
3. `manifest.json.sig` verifies as a detached signature over `manifest.json`.
4. The manifest is schema version 1, uses the selected channel, and contains
   path-safe relative bundle paths.
5. `runtime.filesComplete` is `true`.
6. Every regular file in the runtime tree is listed in `runtime.files[]`.
7. No symlinks or unlisted files are present in the staged runtime tree.
8. Every `runtime.files[]` hash matches.
9. The `bun`, `launcher`, and `agent` entrypoints exist and are included in
   the hashed file list.
10. If a model catalog is declared, its hash matches and it has
   `kind: elizaos.modelCatalog`.
11. The manifest sequence is not below the root-owned channel floor, when a
    floor exists.

If any check fails, the verifier writes a fallback selector pointing at
`/opt/milady`.

## Boot selector state

Verified selector state is written to:

```text
/run/elizaos/runtime.env
/run/elizaos/runtime-selection.json
```

`runtime.env` is shell-safe environment data intended for launcher scripts to
source through `/usr/local/lib/elizaos/runtime-env`. The helper refuses
non-root-owned or group/world-writable selector files and defaults to the baked
runtime when `/run/elizaos/runtime.env` is absent.

The app, agent, and renderer launchers source `runtime-env` and use
`ELIZAOS_BUN`, `ELIZAOS_LAUNCHER`, `ELIZAOS_AGENT_ENTRY`, and
`ELIZAOS_NODE_PATH`. The helper ignores caller-supplied runtime overrides by
default, refuses unsafe selector files, and falls back to `/opt/milady`.

## Rollback behavior

The verifier labels a signed staged runtime as:

- `candidate` when the manifest digest has not been marked good.
- `active` when `update-manager mark-good` has recorded the digest under
`update-state/good/`.
- fallback when the digest is under `update-state/rejected/` or verification
  fails.

The marker commands only operate on the current signed selection in
`/run/elizaos/runtime-selection.json`; they cannot mark an unsigned payload as
trusted. `elizaos-update-health-check.service` runs after the app supervisor
starts and calls:

```sh
/usr/local/lib/elizaos/update-manager mark-good
```

after the agent and renderer pass local readiness checks. It can call
`mark-bad` after timeout only when
`ELIZAOS_UPDATE_HEALTH_MARK_BAD_ON_TIMEOUT=1`; by default, timeout leaves the
candidate unpromoted instead of rejecting a potentially slow boot.

## Systemd unit

`elizaos-update-verify.service` is a oneshot root service:

- runs `/usr/local/lib/elizaos/update-manager verify`
- wants and runs after `tails-persistent-storage.service`
- runs before the Milady system supervisor units
- writes `/run/elizaos` and the root-owned elizaOS persistent runtime store

The image hook enables the unit for `multi-user.target`.

## Manifest and catalog schemas

Schemas live in:

- `schemas/update-manifest.schema.json`
- `schemas/model-catalog.schema.json`

The manifest signs the runtime and pins the optional model catalog by hash.
The model catalog describes model artifacts and capabilities, but model
artifact fetching and model runtime loading remain separate future work.

## Production TODOs

- Generate and bake a real elizaOS update public keyring.
- Decide release channel policy and signing ceremony.
- Add the staging/downloader component that writes the layout above without
  executing payloads.
- Integrate candidate health promotion with user-visible rollback/retry UX.
- Add revocation metadata and stricter product/architecture/OS compatibility
  checks.
- Replace the development signing helper with production key custody and
  signing ceremony.
- Add integration tests with real signed manifests inside an unlocked Tails
  Persistent Storage.
