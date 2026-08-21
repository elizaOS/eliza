---
title: Build and Release
description: "How the monorepo validates builds and publishes an explicit npm release."
---

# Build and release

The repository has one pull-request workflow and one release workflow:

- `.github/workflows/ci.yml` validates every pull request and protected-branch
  push. Its stable `All Tests Passed` aggregate is the only required status.
- `.github/workflows/release.yaml` is manually dispatched from the exact tip of
  `develop`. It builds one immutable package cohort, publishes those tarballs to
  npm, verifies the registry, and only then creates the exact Git tag and GitHub
  Release.

Nightly validation never publishes packages or creates releases. A tag or
GitHub Release event never starts publication.

## Prepare a release

1. Rebase the release change on current `develop`.
2. Run `bun install --frozen-lockfile`, `bun run verify`, `bun run format:check`,
   and `bun run test`.
3. Set the exact cohort version in the manifests governed by
   `packages/scripts/release-cohort.json`.
4. Dispatch `release.yaml` from `develop` with the exact source SHA, canonical
   source ref (`refs/heads/develop`), version, channel, and npm publisher.

The workflow refuses any source SHA, source ref, repository, or workflow
revision that is not the current protected `develop` tip.

## Transaction design

The candidate job has no publishing credentials. It validates the release
identity, tests the source, builds and packs once, records integrity hashes, and
uploads the immutable candidate artifact.

The publication job receives only that artifact and the protected npm
environment. It publishes the recorded tarballs and promotes the complete
cohort to the requested `beta` or `latest` channel.

The finalization job reads every public npm version and channel back before it
pushes the planned tag and creates the GitHub Release. Failed or incomplete
registry publication cannot produce a release tag.

## Desktop and mobile artifacts

Desktop, Android, and Apple builds are release evidence produced with the
package-owned scripts rather than independent GitHub Actions release graphs.
This keeps store credentials and platform troubleshooting out of the npm
transaction.

### Desktop release lane (`release-electrobun.yml`)

`.github/workflows/release-electrobun.yml` is the Electrobun desktop build lane.
It is **tag-bound and upload-only**: it resolves the existing release tag to its
peeled commit SHA, checks out that exact commit for every validation, build, and
release step, and uploads assets to the canonical GitHub Release created by
`release.yaml`. It does not create a missing tag or GitHub Release.

The workflow rejects malformed or nonexistent tags before any build work begins.
For tag-push events, it proves the push SHA resolves to the same tagged commit.
The `release` and OTA jobs re-resolve the tag immediately before publication and
require the canonical non-draft GitHub Release to name the same exact commit. A
moved tag, missing release, conflicting release target, or duplicate asset name
fails closed; the desktop lane never replaces an existing release asset. Manual
dispatches with `draft: true` retain only their Actions build artifacts and do
not mutate the public release or OTA channel.

Useful entry points include:

```bash
node packages/app-core/scripts/desktop-build.mjs build
bash packages/app-core/platforms/electrobun/scripts/smoke-test.sh
bun run --cwd packages/app build:android:cloud
bun run --cwd packages/app build:ios:cloud:sim
```

Run platform builds on the supported host, inspect the installed artifact, and
attach the resulting screenshots, recordings, hashes, and logs to the release
issue. Store submission remains an explicit operator action.

## Local build troubleshooting

The Electrobun packager resolves its CLI from
`packages/app-core/platforms/electrobun/node_modules/.bin` before falling back
to the host. If preload packaging fails around `electrobun/view`:

1. Stop Bun, Electrobun, and Eliza processes.
2. Remove the Electrobun workspace `node_modules` and the root Bun install
   cache for this checkout.
3. Run `bun install --frozen-lockfile`.
4. Run `node packages/app-core/scripts/desktop-build.mjs preflight`.
5. Retry the desktop build and packaged smoke test.

Do not use a green build command as a substitute for launching and inspecting
the produced application.
