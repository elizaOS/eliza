# Application Updates

Eliza has several runtime surfaces, but every surface must answer the same
question before it updates anything: who owns the executable bits? The app may
only self-update where the install channel permits it. Everywhere else Settings
must show version, channel, release notes, and the authority that owns the
upgrade path.

The current implementation starts that model in
`packages/ui/src/services/app-updates/update-policy.ts`. Direct desktop builds
wire the policy to Electrobun's updater in
`packages/app-core/platforms/electrobun/src/native/desktop.ts`; CLI and remote
agents expose package-manager status through `packages/agent/src/api/update-routes.ts`;
cloud containers are created from Docker image refs in
`cloud/packages/lib/config/containers-env.ts` and
`cloud/packages/lib/services/coding-containers.ts`.

## Policy Boundary

Store builds are not "less automatic"; they are externally managed. The best UX
is to show that clearly and deep-link to release notes or the store, not to hide
updates behind a button that cannot work.

- Apple App Store and Mac App Store builds must not download executable code or
  install app updates outside Apple's review/update path. App Review guideline
  2.5.2 covers downloaded executable code, and 2.4.5(vii) covers Mac App Store
  update mechanics:
  https://developer.apple.com/app-store/review/guidelines/
- iOS EU Web Distribution and alternative marketplaces are still Apple
  controlled distribution paths. Apple says Web Distribution apps must satisfy
  Notarization requirements and install only from registered App Store Connect
  domains:
  https://developer.apple.com/support/web-distribution-eu/
- Google Play apps may not modify, replace, or update themselves outside Google
  Play's update mechanism:
  https://support.google.com/googleplay/android-developer/answer/16273414
- Debian/apt, Snap, Flatpak, and stores own their package channels. Apt trusts
  signed repository metadata through `apt-secure`:
  https://manpages.debian.org/unstable/apt/apt-secure.8.en.html
- Snap refreshes are automatic by default and checked by `snapd` several times a
  day:
  https://snapcraft.io/docs/how-to-guides/manage-snaps/manage-updates/
- Flatpak updates are handled by `flatpak update` for applications and runtimes:
  https://docs.flatpak.org/en/latest/using-flatpak.html
- Microsoft Store can automatically install app updates, while some Win32
  publishers still manage their own update path:
  https://support.microsoft.com/windows/turn-on-automatic-app-updates-70634d32-4657-dc76-632b-66048978e51b

## Target Matrix

| Surface | Distribution | Current code | Update authority | App-controlled OTA |
| --- | --- | --- | --- | --- |
| macOS direct desktop | DMG/zip/Homebrew cask | Electrobun updater, `ELIZA_RELEASE_URL`, `/Applications` eligibility guard | GitHub release feed or mirror | Yes |
| Windows direct desktop | installer/portable | Electrobun updater | GitHub release feed or mirror | Yes |
| Linux direct desktop | AppImage/deb/rpm/tar | Electrobun updater, future package feed | GitHub release feed or package manager | Yes for Electrobun artifacts; package manager for deb/rpm |
| Mac App Store | MAS | `MILADY_BUILD_VARIANT=store` disables updater | Mac App Store | No |
| Microsoft Store | MSIX/Win32 Store | store policy model needed per packaging target | Microsoft Store or publisher-owned Win32 channel | Usually store-managed unless published as direct Win32 |
| Debian OS | apt/unattended-upgrades | CLI detects `apt` for agent package updates | Debian/Ubuntu apt repos and system administrator | No app-driven OS update |
| Snap | Snap Store | CLI detects `snap` | `snapd` refresh | No app-driven updater |
| Flatpak/Flathub | Flatpak repo | CLI detects `flatpak` | Flatpak remote | No app-driven updater |
| iOS App Store | App Store/TestFlight | mobile store build variant | Apple | No |
| iOS EU web/marketplace | Web Distribution/marketplace | policy should report externally managed | Apple notarization + marketplace/web domain | No in-app binary OTA |
| iOS local/sideload | Xcode/dev/sideload tools | policy links release notes only | developer toolchain | No |
| Android Google Play | Play | `android-cloud` store build strips restricted local runtime/perms | Google Play | No |
| Android third-party store | Amazon/Samsung/Huawei/F-Droid/enterprise | policy should report externally managed | selected store or MDM | No silent self-update |
| Android sideload | GitHub APK | `android` direct build | GitHub release + Android package installer consent | Link only; user installs |
| Android AOSP/ElizaOS | system image/privileged APK | `android-system` plus `scripts/distro-android` | OTA image/privileged package channel | Not from normal app UI |
| Cloud container agent | GHCR/Docker image | image refs default to `ghcr.io/elizaos/eliza:latest` | control plane rollout | Replace container, not in-container self-update |
| Remote server agent | npm/bun/Homebrew/snap/apt/flatpak/local-dev | `/api/update/status`, `eliza update` | package manager/operator | Only through explicit operator command |
| Local desktop embedded agent | bundled in desktop app | spawned from packaged runtime in Electrobun | desktop app updater | Updated with app relaunch |
| Web | hosted assets | Vite/static deployment | web deploy/CDN | Reload only |

## What We Have

- Settings now shows app version/build/distribution and the correct update
  authority for desktop, iOS, Android, AOSP, and web.
- Direct desktop auto-update exists through Electrobun. Store builds and macOS
  apps outside `/Applications` are explicitly disabled.
- The CLI/agent already has a package-manager update checker:
  `npm-global`, `bun-global`, `homebrew`, `snap`, `apt`, `flatpak`,
  `local-dev`, and `unknown`.
- The agent API already exposes `GET /api/update/status` and
  `PUT /api/update/channel`, so local and remote UIs can display version,
  channel, dist-tags, latest version, install method, and errors.
- Mobile build scripts already separate Play-safe `android-cloud`, sideload
  `android`, privileged `android-system`, store-ish `ios`, and dev `ios-local`
  targets.
- The AOSP distribution scripts build the APK, sync the vendor tree, build the
  image, and boot-validate Cuttlefish.
- Cloud container creation already records `image_tag`, env, node, persistent
  volume, public URL, status, and health metadata.

## What We Need

1. Define a shared `UpdateAuthority` contract used by Settings, CLI REST, cloud
   dashboards, and release tooling:
   `authority`, `currentVersion`, `currentBuild`, `channel`, `installMethod`,
   `canAutoUpdate`, `canManualUpdate`, `releaseNotesUrl`, `lastCheckAt`,
   `managedBy`, `nextAction`, and `risk`.
2. Add version provenance everywhere:
   app package version/build, embedded agent package version, remote agent
   version, Docker image tag plus digest, AOSP build fingerprint/OTA version,
   Debian package version, and store build number.
3. Stop using mutable cloud defaults for rollout decisions. `latest` can remain
   a dev fallback, but production containers should store an immutable image
   digest and a desired image digest.
4. Add cloud rollout primitives: canary, drain active work, snapshot/backup
   volume, stop old container, pull new image, start new container, health
   probe, promote, rollback, and audit log.
5. Add AOSP OTA tooling around the existing image builder: signed full OTA,
   signed incremental OTA where possible, rollback testing, boot-slot health,
   and release metadata hosted from GitHub Releases or a static mirror.
6. Add store-aware deep links:
   App Store/TestFlight, Google Play, Microsoft Store, Snap Store, Flathub,
   F-Droid, GitHub Releases, Homebrew tap, and apt repository instructions.
7. Add UI rows for app, embedded agent, connected remote agent, cloud container,
   and OS/package-manager status. Rows that cannot update in-app should say
   why and provide the next allowed action.

## What We Do Not Need

- No mobile code-push system for executable behavior in store builds. It creates
  review and policy risk and is not needed for this app's native/runtime model.
- No in-app OS updater for Debian. We can report host/package status; apt,
  unattended-upgrades, or the administrator performs OS upgrades.
- No silent sideload updater for Android. GitHub APK builds can link releases,
  but Android installer consent and signature continuity remain mandatory.
- No desktop app updating arbitrary remote servers. The UI may display remote
  status and offer commands, but privileged remote updates need an operator
  channel such as SSH, systemd, MDM, apt, or cloud control plane authorization.
- No independent updater inside cloud containers. Containers should be replaced
  by the control plane so image provenance, rollback, and audit stay coherent.

## Platform Plans

### Direct Desktop

Direct Electrobun builds are the only app-controlled binary auto-update path.
Publish signed artifacts and Electrobun update metadata from GitHub Releases,
optionally mirrored to static storage for rate-limit protection. Startup checks
should stay forced on for direct builds, and Settings should provide manual
check/download/apply. macOS remains disabled unless installed in `/Applications`
or `~/Applications` because patching a translocated app bundle is unreliable.

### Store Desktop

Mac App Store, Microsoft Store, Snap, and Flatpak builds should use
`MILADY_BUILD_VARIANT=store` or a target-specific equivalent and disable the
Electrobun feed. Settings should show "Managed by Store" and release notes.
Win32 submitted through Microsoft Store needs a packaging decision: if Store
owns the package, disable self-update; if Microsoft allows a publisher-managed
Win32 updater for that listing, treat it as a direct Windows channel and
document it explicitly per submission.

### Debian OS And Debian Packages

For Debian hosts, split "OS updates" from "Eliza package updates." OS updates
belong to the system administrator via apt/unattended-upgrades. Eliza package
updates should come from a signed apt repository with Release metadata and a
stable package name. The app can show package version and whether `apt` is the
install method, but it should not run OS upgrades from Settings.

Release authority for Debian-like targets is explicit:

- OS packages: Debian/Ubuntu archive, private apt repo, or the administrator's
  configured mirror. Settings may surface `apt` status, lock errors, held
  packages, and the exact command/operator action.
- Direct desktop `.deb`: if shipped as an Electrobun artifact, GitHub Releases
  can own the app updater metadata. If installed from apt, apt owns updates and
  the in-app updater must be disabled.
- Server agent package: the package manager/operator owns updates. A future
  remote update endpoint must be admin-authenticated, audited, supervised, and
  rollback-aware before it can run privileged commands.

### Android Apps

`android-cloud` is the Play-compliant thin client and must remain store-managed.
`android` can publish APKs on GitHub, but Settings should only open the release
page; Android will require package-installer consent and the same signing key.
Third-party stores should be modeled like stores, not like GitHub sideload,
unless that store explicitly delegates updates back to the publisher. F-Droid is
possible only if the app can meet its source/build/signing expectations; when
F-Droid signs builds differently, cross-updates with GitHub/Play will fail due
to Android signature rules.

The mobile build script now exposes the release-authority mapping through
`resolveMobileBuildPolicy`:

| Target | Build variant | Runtime mode | Release authority | Allowed Settings action |
| --- | --- | --- | --- | --- |
| `android-cloud` | `store` | `cloud` | Google Play | Open Play/release notes |
| `android` | `direct` | `local` | GitHub Release + Android package installer | Open GitHub release; user installs |
| `android-system` | `direct` | `local` | AOSP OTA/privileged package channel | Show OTA/version status only |
| `ios` | `store` | `cloud` | Apple App Store/TestFlight | Open App Store/TestFlight/release notes |
| `ios-local` | `direct` | `local` | Xcode, Apple Configurator, MDM, or developer sideload tooling | Show build provenance/release notes |

None of these mobile targets has app-controlled binary OTA. The direct mobile
variant means "not app-store sandboxed"; it does not mean the app may silently
replace itself.

### Android AOSP / ElizaOS

Privileged AOSP builds are not normal APK updates. The durable path is signed
A/B or Virtual A/B OTA for the system image, with the privileged APK included in
the image or delivered through a platform-signed privileged channel. Android's
current mainline OTA mechanism is Virtual A/B:
https://source.android.com/docs/core/ota/virtual_ab

The existing `scripts/distro-android` pipeline should grow release jobs that
emit build fingerprint, OTA metadata, signed full OTA, optional incremental OTA,
Cuttlefish boot validation, and rollback validation. GitHub can host metadata
and artifacts, but devices must verify payload signatures before install.

The first metadata guard is
`scripts/distro-android/validate-ota-metadata.mjs`. It validates a JSON release
index without requiring an AOSP checkout or build artifacts. The file is meant
to sit beside signed OTA ZIPs on GitHub Releases or a static mirror and must
record the brand, package name, channel, release version, build ID/fingerprint,
security patch level, release notes URL, and one or more payloads. Each payload
declares `type`, `fileName`, `url`, `sha256`, `sizeBytes`,
`targetBuildFingerprint`, rollback index fields, and optional
`payloadPropertiesUrl`/`metadataSha256`.

Example local validation:

```bash
node scripts/distro-android/validate-ota-metadata.mjs \
  --brand-config scripts/distro-android/brand.eliza.json \
  path/to/ota-release.json
```

Use `--allow-file-urls` only for local dry-runs; published release metadata
should use HTTPS URLs.

### iOS

App Store/TestFlight, EU Web Distribution, alternative marketplaces, enterprise
MDM, and local sideload all remain externally managed. Settings can show
version/build and release notes. It must not download a replacement app bundle
or executable runtime. For EU Web Distribution, the install/update path is still
the Apple-notarized domain/marketplace path, not our app UI.

### Cloud Container Agent

Cloud agents should never run `eliza update` inside the container. The control
plane should replace containers using pinned image digests, persistent volume
snapshots, health checks, and rollback. The current `image_tag` column is useful
but insufficient for production rollouts; add `current_image_digest`,
`desired_image_digest`, `release_version`, `rollout_status`, and
`last_successful_image_digest` either as columns or typed metadata.

Coding containers are interactive workspaces, so automatic rollout should be
conservative. Default to pinned image per session, pre-pull newer images for
future sessions, and offer an explicit "rebase runtime" action that snapshots
the workspace volume before replacing the container.

### Remote Server Agent

Remote agents already expose update status. The UI should display that status
but not silently execute privileged package-manager commands. Recommended flow:
show current/latest/channel/install method, provide exact command or operator
action, and support an authenticated remote update only after adding audit logs,
CSRF protection, admin authorization, process supervision, timeout, restart, and
rollback behavior.

### Local Desktop Agent

Packaged desktop uses the embedded runtime, so the direct desktop updater is the
agent updater. After apply/relaunch, the child process starts from the new
runtime. Local-dev agents should remain `git pull`/workspace managed and should
show "local development install" rather than an update button.

## Failure Modes

- Store rejection from self-updating executable code: hard-disable updater feeds
  in store/mobile builds and test the policy matrix.
- Signature mismatch: keep long-lived signing keys, document rotation, and
  reject cross-channel installs with different Android/iOS/Desktop identities.
- Partial downloads or corrupted artifacts: require signed metadata, checksums,
  atomic install, and rollback.
- GitHub rate limits/outages: mirror release metadata to static storage and
  cache status with last-check timestamps.
- Mutable `latest` container drift: record immutable digests and desired state.
- Cloud data loss: snapshot or backup persistent volumes before replacement.
- Cloud downtime: canary, drain, health probe, promote, and rollback instead of
  replacing every container at once.
- Database/schema skew: define min/max compatible agent versions and run
  migrations before promotion.
- Remote command privilege abuse: never expose "update remote" without admin
  auth, audit, confirmation, and command allowlists.
- Apt/dpkg locks or interrupted package upgrades: surface lock errors and retry
  guidance; do not kill package-manager processes.
- Android OTA bricking: require signed payload verification, slot rollback,
  battery/storage checks, and Cuttlefish plus hardware smoke.
- AOSP rollback/index issues: validate rollback metadata and boot success before
  marking an OTA stable.
- Store rollout lag: Settings should say "managed by store" and avoid claiming
  a release is installable before the store exposes it.
- Protocol skew between app and agent: show both versions and gate incompatible
  features with capability checks.
- Offline mode: show cached status and last successful check, not a false
  "current" claim.

## Implementation Plan

1. Keep the current Settings policy tests and Electrobun availability tests as
   the base gate.
2. Extend `ApplicationUpdateSnapshot` into a shared update status contract and
   map existing CLI `/api/update/status` into it.
3. Add Settings sections for app, embedded/local agent, connected remote agent,
   cloud container, and package/OS authority.
4. Add release metadata generation in GitHub Actions for desktop artifacts,
   npm dist-tags, Docker image digests, apt repo metadata, Android APKs, AOSP
   OTA artifacts, and store release notes.
5. Implement cloud rollout state in the DB/service layer, then add canary and
   rollback endpoints to the container control plane.
6. Add AOSP OTA release jobs around `scripts/distro-android/build-aosp.mjs` and
   Cuttlefish boot validation.
7. Add packaging smoke tests for direct desktop, store desktop, Play Android,
   sideload Android, AOSP image, iOS store/local, apt, snap, flatpak, Docker
   rollout, and remote server status.

## Verification

- `packages/app-core/platforms/electrobun/src/update-availability.test.ts`
  verifies desktop direct/store eligibility, including the macOS
  `/Applications` requirement.
- `packages/ui/src/services/app-updates/update-policy.test.ts` verifies the
  Settings policy matrix for desktop, iOS, Android Play, Android sideload, and
  AOSP.
- Desktop packaged smoke should verify Settings -> Updates shows app version,
  desktop version, channel, distribution, auto-update status, and the correct
  disabled reason for store or non-installed macOS builds.
- Mobile packaged smoke should verify store builds have no installer/update
  button and direct/sideload builds only open release notes.
- Cloud rollout smoke should deploy `old digest -> new digest`, pass health,
  preserve volume data, then force a failing image and verify rollback.
- AOSP smoke should boot Cuttlefish from the released image, install OTA, reboot
  into the new slot, verify privileged app version, then exercise rollback on a
  deliberately bad build.
