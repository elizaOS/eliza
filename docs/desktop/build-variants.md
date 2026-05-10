# Desktop Build Variants

Eliza desktop ships in two local build variants. The source tree is shared; the
distribution channel decides which local capabilities are available.

## Store Variant

Use this for Mac App Store, Microsoft Store, and Flathub builds.

- `MILADY_BUILD_VARIANT=store`
- Runs inside the platform app sandbox.
- Forces local code-execution surfaces off: terminal commands, shell plugins,
  coding tools, and coding-agent orchestration are not loaded.
- Routes local agent work through Eliza Cloud instead of starting an embedded
  host agent.
- Stores app state under the app-container data directory via
  `MILADY_STATE_DIR`.
- Allows users to import a direct-build state directory through the desktop
  settings panel. On macOS, the folder picker returns a security-scoped
  bookmark so access can be restored without broad filesystem entitlement.

Store builds can still connect to Cloud or a remote agent. Cloud hosting is its
own runtime target; it is not replaced by the local desktop sandbox.

## Direct Variant

Use this for the downloadable DMG, Windows installer, AppImage, deb/rpm, and
other side-loaded desktop builds.

- `MILADY_BUILD_VARIANT=direct` or unset.
- Runs with normal host filesystem/process access.
- Enables local terminal, coding tools, coding-agent CLIs, local Ollama, and
  other power-user workflows.
- Uses the normal namespace state directory, such as `~/.eliza`, unless
  `MILADY_STATE_DIR` or `ELIZA_STATE_DIR` is explicitly set.

## Mobile

Vanilla iOS and Google Play Android are thin clients. They do not run Bun or a
local agent backend in-app; Cloud hosting provides the sandboxed agent runtime.

The AOSP native Android build is a privileged system build and runs on-device.
It does not expose a sandbox choice because the system image is already the
target environment for local shell and terminal access.

## Human Release Requirements

The codebase can build the variants and enforce runtime gates, but store release
steps still require human-controlled accounts and credentials:

- Apple Developer account, Mac App Store signing identities, and App Review
  entitlement explanations.
- Microsoft Partner Center identity and MSIX signing certificate.
- Flathub maintainer account, appstream screenshots, and Flathub submission.
