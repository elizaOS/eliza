# Release secrets checklist

This is the consolidated index of every credential the release and channel
workflows read, one row per secret, with the workflow that reads it and where
the value originates. Use it as the pre-flight gate before running the relevant
workflow on a fresh repo, and as the audit list when rotating credentials. An
entry here does not imply that the retained coordinator currently calls it.

Each channel has a dedicated maintainer playbook (credential generation → repo
secret → sanity `workflow_dispatch` → rotation/revocation). This page is the
map; the playbooks are the procedure.

| Channel | Playbook |
| --- | --- |
| Android (keystore + Play Store) | [release-secrets-android.md](./release-secrets-android.md) |
| Apple (iOS App Store + Mac App Store) | [release-secrets-apple.md](./release-secrets-apple.md) |
| Homebrew tap | [release-secrets-homebrew.md](./release-secrets-homebrew.md) |
| Snap Store | [release-secrets-snap.md](./release-secrets-snap.md) |
| Windows Store + Authenticode signing | [release-secrets-windows.md](./release-secrets-windows.md) |
| Debian apt repo | [admin-apt-repo-setup.md](./admin-apt-repo-setup.md) |

Flatpak bundle creation is available through `publish-packages.yml`, but
Flathub submission is unavailable until the canonical app repository exists.
There is no Flathub submission credential consumer; do not interpret a built
bundle as a successful store publication.

## How secrets reach the workflows

Channel workflows expose reusable (`workflow_call`) and manual
(`workflow_dispatch`) entry points. Credentials reach a reusable workflow only
through an explicit parent with `secrets: inherit`. `release-orchestrator.yml`
currently calls `publish-packages.yml`, Android, Apple, Electrobun, Homebrew,
and homepage distribution. `publish-packages.yml` directly owns its PyPI, Snap,
APT-dispatch, and Flatpak-bundle steps; it does not call `snap-publish.yml`.
`elizaos-os-full-release.yml` separately calls the Debian apt publisher. Windows
Store and `snap-publish.yml` remain standalone entry points.

The two Snap paths consume different credentials: orchestrated
`publish-packages.yml` reads `SNAP_STORE_CREDENTIALS`, while standalone
`snap-publish.yml` reads `SNAPCRAFT_STORE_CREDENTIALS`. Missing
`SNAP_STORE_CREDENTIALS` or `APT_REPO_TOKEN` currently skips the corresponding
store mutation while the containing build job can still succeed. That is a
known fail-open completion defect in the retained coordinator, tracked in
[#16279](https://github.com/elizaOS/eliza/issues/16279); a green build is not
evidence that either store was updated.

GitHub validates a reusable workflow's secret contract **before any job starts**.
To stop a missing optional secret from aborting the whole pipeline at startup
with no logs, every channel secret is declared `required: false`, and the job
body has an explicit "check credentials" step that warns and skips (or fails
loudly inside the job) when the secret is absent. This is the same pattern
established for the apt repo in PR #7976.

Set all secrets at: **repo Settings → Secrets and variables → Actions → New
repository secret** (`https://github.com/elizaOS/eliza/settings/secrets/actions`).
Org-level secrets work too if you want to share a credential across repos.

`GITHUB_TOKEN` is provided automatically by Actions and is **not** something you
configure.

## Origin legend

- **generate fresh** — create a new credential dedicated to CI (preferred for
  signing keys and service principals so it can be revoked independently).
- **re-enter from source** — copy an existing value out of a store/dashboard
  (an issued certificate, an App Store Connect key, a registered Store app ID).

## Every secret, by channel

### Android — [release-secrets-android.md](./release-secrets-android.md)

Workflow: `android-release.yml`

| Secret | Consumed by | Origin |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Decoded to `/tmp/elizaos-upload.jks`, used to sign the AAB + APK | generate fresh (upload keystore) — base64 of the `.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | `ELIZAOS_KEYSTORE_PASSWORD` for gradle signing | re-enter from source (chosen at keystore creation) |
| `ANDROID_KEY_ALIAS` | `ELIZAOS_KEY_ALIAS` for gradle signing | re-enter from source (chosen at keystore creation) |
| `ANDROID_KEY_PASSWORD` | `ELIZAOS_KEY_PASSWORD` for gradle signing | re-enter from source (chosen at keystore creation) |
| `PLAY_STORE_SERVICE_ACCOUNT_JSON` | Decoded for `fastlane supply` upload to Play Store; gates the `publish-play-store` job | generate fresh (Google Cloud service-account JSON), then base64 |

### Apple — [release-secrets-apple.md](./release-secrets-apple.md)

Workflow: `apple-store-release.yml`

| Secret | Consumed by | Origin |
| --- | --- | --- |
| `APPLE_ID` | Apple account for upload / notarization | re-enter from source (Apple Developer account email) |
| `APPLE_TEAM_ID` | Apple Developer Team ID | re-enter from source (membership details) |
| `ITC_TEAM_ID` | App Store Connect (iTunes Connect) team ID | re-enter from source |
| `APP_STORE_APP_ID` | TestFlight / App Store delivery target | re-enter from source (App Store Connect app) |
| `MATCH_PASSWORD` | Decrypts the Fastlane Match cert repo | re-enter from source (the Match passphrase) |
| `MATCH_GIT_URL` | Git URL of the Match cert repo | re-enter from source |
| `MATCH_GIT_BASIC_AUTHORIZATION` | Basic-auth for the Match cert repo | generate fresh (base64 of `user:PAT`) |
| `APPLE_APP_SPECIFIC_PASSWORD` | `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD` for upload | generate fresh (appleid.apple.com app-specific password) |
| `MAS_CSC_LINK` | `CSC_LINK` — Mac App Store app cert (`.p12`) | re-enter from source (issued cert), base64 |
| `MAS_CSC_KEY_PASSWORD` | `CSC_KEY_PASSWORD` for the app cert | re-enter from source (`.p12` export password) |
| `MAS_INSTALLER_CERT` | 3rd Party Mac Developer Installer cert (`.p12`) | re-enter from source (issued cert), base64 |
| `MAS_INSTALLER_KEY_PASSWORD` | Password for the installer cert | re-enter from source (`.p12` export password) |
| `APP_STORE_API_KEY_ID` | App Store Connect API key id (`xcrun altool --apiKey`) | re-enter from source |
| `APP_STORE_API_ISSUER_ID` | App Store Connect API issuer id (`--apiIssuer`) | re-enter from source |
| `APP_STORE_API_KEY_P8` | The `.p8` private key contents written to `AuthKey_<id>.p8` | generate fresh (App Store Connect API key, downloads once) |

### Homebrew — [release-secrets-homebrew.md](./release-secrets-homebrew.md)

Workflow: `update-homebrew.yml`

| Secret | Consumed by | Origin |
| --- | --- | --- |
| `HOMEBREW_TAP_TOKEN` | `repository-dispatch` token to trigger `elizaOS/homebrew-tap`; gates the dispatch | generate fresh (GitHub PAT with repo scope on `elizaOS/homebrew-tap`) |

### Orchestrated package distribution

Workflow: `publish-packages.yml`, called by `release-orchestrator.yml`

| Secret | Consumed by | Origin |
| --- | --- | --- |
| `PYPI_API_TOKEN` | Fallback password for `pypa/gh-action-pypi-publish` when trusted publishing is unavailable | generate fresh (PyPI project token); prefer configured OIDC trusted publishing |
| `SNAP_STORE_CREDENTIALS` | `snapcore/action-publish` in the orchestrated Snap job | generate fresh (Snap Store login exported for the action) |
| `APT_REPO_TOKEN` | `gh api` repository dispatch to `elizaOS/apt` after the `.deb` is attached | generate fresh (GitHub token scoped to the apt repository dispatch) |

### Snap — [release-secrets-snap.md](./release-secrets-snap.md)

Workflow: `snap-publish.yml`

| Secret | Consumed by | Origin |
| --- | --- | --- |
| `SNAPCRAFT_STORE_CREDENTIALS` | `snapcraft upload`; gates the Store upload (build still runs) | generate fresh (`snapcraft export-login`) |

### Windows — [release-secrets-windows.md](./release-secrets-windows.md)

Workflow: `windows-store-release.yml`

| Secret | Consumed by | Origin |
| --- | --- | --- |
| `WINDOWS_SIGN_CERT_BASE64` | Decoded to `signing.pfx`; signs the MSIX (shared with desktop Authenticode signing) | re-enter from source (code-signing cert), base64 of the `.pfx` |
| `WINDOWS_SIGN_CERT_PASSWORD` | Password for the signing `.pfx` | re-enter from source (`.pfx` export password) |
| `MS_TENANT_ID` | Azure AD tenant for the Partner Center token; gates the `submit-to-store` job | re-enter from source (Azure AD → Directory (tenant) ID) |
| `MS_CLIENT_ID` | Azure AD app (service principal) client id | re-enter from source (Azure AD app registration) |
| `MS_CLIENT_SECRET` | Azure AD app client secret | generate fresh (Azure AD → Certificates & secrets) |
| `MS_APP_ID` | Microsoft Store app id (Partner Center) | re-enter from source (Partner Center Store ID) |

### Debian apt repo — [admin-apt-repo-setup.md](./admin-apt-repo-setup.md)

Workflow: `publish-apt-repo.yml`

| Secret | Consumed by | Origin |
| --- | --- | --- |
| `DEBIAN_GPG_PRIVATE_KEY` | Armored GPG private key reprepro signs the `Release` file with | generate fresh (dedicated GPG key) |
| `DEBIAN_GPG_KEY_ID` | 16-char hex key id passed to reprepro | re-enter from source (the generated key's id) |
| `DEBIAN_GPG_PASSPHRASE` | Passphrase for the GPG key (optional) | re-enter from source (chosen at key creation; omit if none) |

## OTA release host (optional)

Not a store channel — an optional self-hosted CDN that `release-electrobun.yml`
uploads OTA files to alongside GitHub Releases. If unconfigured, OTA is served
from GitHub Releases (the default, fully functional path).

| Item | Kind | Origin |
| --- | --- | --- |
| `RELEASE_UPLOAD_KEY` | secret | generate fresh (deploy SSH private key) |
| `RELEASE_HOST_FINGERPRINT` | secret | re-enter from source (`ssh-keyscan -H <host>`) |
| `RELEASE_HOST` | repo **variable** | re-enter from source (release hostname) |

`WINDOWS_SIGN_TIMESTAMP_URL` (RFC 3161 timestamp server, e.g.
`http://timestamp.digicert.com`) is read by `release-electrobun.yml` for the
desktop Authenticode path; the MSIX build defaults it when unset.

## Pre-release gate

A channel is ready to publish only when every secret in its row block is set.
The half-configured failure mode is the dangerous one: a build that succeeds but
skips the store upload, or an unsigned artifact. The current checks surface some
gaps as warnings, but the orchestrated Snap/APT build jobs can still report
success after their store mutation skipped. Treat those runs as incomplete
until #16279 makes enabled-channel completion fail closed.

Run each channel's `workflow_dispatch` once (see the channel playbook) before
trusting it inside the orchestrated release.

## Related

- [admin-apt-repo-setup.md](./admin-apt-repo-setup.md) — the original playbook
  this set mirrors (apt repo GPG signing).
- [installers-release-plan.md](./installers-release-plan.md) — release artifact
  requirements and validation gates.
- [ci-cd-production-plan.md](./ci-cd-production-plan.md) — broader pipeline
  status.
