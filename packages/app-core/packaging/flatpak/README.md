# Flatpak side-load packaging

These manifests build x86_64 bundles for local testing, GitHub Release
attachments, and other side-load distribution. Both consume a native production
runtime generated from the exact checkout before `flatpak-builder` starts.
That runtime is intentionally ignored by git, so neither manifest is currently
self-contained enough for Flathub's remote build service.

| Variant | Manifest | Wrapper | Posture |
|---------|----------|---------|---------|
| Hardened | `ai.elizaos.App.store.yml` | `elizaos-app-wrapper.store.sh` | Restricted home access and store-mode runtime gates |
| Direct | `ai.elizaos.App.yml` | `elizaos-app-wrapper.sh` | Full home access for a side-loaded power-user build |

The prepared closure is architecture-specific and may include native addons.
The release and test lanes therefore build it on x86_64, package the matching
x86_64 Node 24.15.0 archive, and reject other build hosts. ARM64 support requires
a separate native build-and-boot lane before an ARM source can be restored to
the manifests.

The runtime preparer uses the committed Bun lockfile and the repository's exact
Node and Bun toolchain. It retains each workspace package's own version, installs
the production closure, and rejects source-path residue, escaped links, missing
artifacts, and unresolved runtime probes before Flatpak sees the payload.

The Node module preserves the complete upstream `LICENSE` as
`/app/share/licenses/ai.elizaos.App/nodejs-LICENSE` and installs
`node-runtime-provenance.json` beside it. That record is mechanically checked
against the shared locked-Node helper: Node 24.15.0, the official Linux x64
archive SHA-256 `472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6`,
the official source archive SHA-256
`a4f653d79ed140aaad921e8c22a3b585ca85cfdab80d4030f6309e4663a8a1c8`,
and executable SHA-256
`d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c`.

The exact repository MIT license is installed as
`/app/share/licenses/ai.elizaos.App/elizaos-LICENSE`. The runtime builder also
verifies every package in the hashed dependency inventory emitted from its
frozen Bun install, records installed manifest and payload digests, and retains
every artifact-local license or notice byte in `third-party-notices.json`.
Installed smokes compare both legal files with the copies inside
`/app/lib/elizaos-app` and validate the inventory counts; the project license
does not make a blanket MIT claim about third-party code.

FFmpeg executables are deliberately outside that closure. The manifests use
Freedesktop's `org.freedesktop.Platform.ffmpeg-full//24.08` extension point and
create `/app/lib/ffmpeg` for its codec libraries. The wrappers pin all supported
media environment variables to the platform's `/usr/bin/ffmpeg` and
`/usr/bin/ffprobe`. Freedesktop/Flathub distributes that media stack and remains
its source and license-compliance boundary; the elizaOS bundle retains only the
npm adapters that call it.

## Sandbox profiles

The hardened profile grants network access and the fixed `~/Documents/Eliza`
directory. The latter is a manifest filesystem grant; it is not a FileChooser
portal selection. App state and configuration remain in Flatpak's persistent
per-app XDG directories without a host filesystem grant; the wrapper explicitly
sets `ELIZA_STATE_DIR=$XDG_STATE_HOME/eliza`. The profile does not grant the
whole home directory, host XDG configuration, the host filesystem, display
sockets, raw devices, session/system buses, or the Flatpak host-spawn D-Bus
name.

Its wrapper exports `ELIZA_BUILD_VARIANT=store`. Runtime components use that
signal to disable features that require arbitrary local process execution,
including coding-shell and PTY surfaces. It does not imply that every remaining
runtime feature is cloud-only.

The direct profile grants the sandbox the user's home directory and leaves the
runtime in direct mode. It is appropriate only when that broader file access is
intentional. It still does not add the `org.freedesktop.Flatpak` host-spawn
D-Bus permission.

Portal services such as OpenURI remain available through the Freedesktop
runtime without an explicit `--talk-name=org.freedesktop.portal.*` grant.

## Local build and smoke

Install Flatpak and the 24.08 runtime/SDK, then run the repository build driver:

```bash
sudo apt install flatpak flatpak-builder
sudo flatpak remote-add --if-not-exists --system flathub \
  https://dl.flathub.org/repo/flathub.flatpakrepo
sudo flatpak install --system flathub org.freedesktop.Platform//24.08
sudo flatpak install --system flathub org.freedesktop.Sdk//24.08
sudo flatpak install --system flathub org.freedesktop.Platform.ffmpeg-full//24.08

# Hardened side-load profile (the default).
bun run --cwd packages/app-core build:flatpak

# Direct side-load profile.
bun run --cwd packages/app-core build:flatpak:direct
```

The driver builds `@elizaos/agent` and its workspace dependencies, prepares the
locked production runtime and legal inventory, invokes `flatpak-builder`, and
writes `dist-flatpak/elizaos-app.flatpak`.

Install and exercise the resulting bundle without exposing the host account's
normal Flatpak state:

```bash
ISOLATION_ROOT="$(mktemp -d /tmp/elizaos-flatpak.XXXXXX)"
export HOME="$ISOLATION_ROOT/home"
export XDG_CONFIG_HOME="$ISOLATION_ROOT/config"
export XDG_CACHE_HOME="$ISOLATION_ROOT/cache"
export XDG_DATA_HOME="$ISOLATION_ROOT/data"
export XDG_STATE_HOME="$ISOLATION_ROOT/state"
export XDG_RUNTIME_DIR="$ISOLATION_ROOT/runtime"
install -d -m 700 "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" \
  "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" \
  "$ISOLATION_ROOT/verifier"

sudo flatpak --system install -y dist-flatpak/elizaos-app.flatpak
sudo flatpak --system run --command=/bin/sh ai.elizaos.App -s <<'EOF'
set -eu
NODE_LICENSE=/app/share/licenses/ai.elizaos.App/nodejs-LICENSE
NODE_PROVENANCE=/app/share/licenses/ai.elizaos.App/nodejs-runtime-provenance.json
PROJECT_LICENSE=/app/share/licenses/ai.elizaos.App/elizaos-LICENSE
THIRD_PARTY_NOTICES=/app/share/licenses/ai.elizaos.App/third-party-notices.json
test "$(/app/bin/node --version)" = v24.15.0
test "$(/usr/bin/sha256sum /app/bin/node | /usr/bin/cut -d ' ' -f 1)" = d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c
test "$(/usr/bin/sha256sum "$NODE_LICENSE" | /usr/bin/cut -d ' ' -f 1)" = 4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18
test "$(/usr/bin/sha256sum "$NODE_PROVENANCE" | /usr/bin/cut -d ' ' -f 1)" = 7b8cd9c2ea24afdb7ad8b1a0ba29a205909181a82ca25c3f45bcea96b9a8cc5f
test "$(/usr/bin/sha256sum "$PROJECT_LICENSE" | /usr/bin/cut -d ' ' -f 1)" = d0590837a439c742e89c8226137dd4e902fa1e0df486347dbfc9b8ba68b5826d
/usr/bin/cmp "$PROJECT_LICENSE" /app/lib/elizaos-app/LICENSE
/usr/bin/cmp "$THIRD_PARTY_NOTICES" /app/lib/elizaos-app/THIRD_PARTY_NOTICES.json
STATE_SENTINEL="$XDG_STATE_HOME/eliza/flatpak-persistence-smoke"
/usr/bin/mkdir -p "$XDG_STATE_HOME/eliza"
: > "$STATE_SENTINEL"
MEDIA_SMOKE="/tmp/elizaos-ffmpeg-smoke-$$.mp4"
/usr/bin/ffmpeg -hide_banner -loglevel error \
  -f lavfi -i color=c=black:s=16x16:d=0.04 \
  -c:v libx264 -pix_fmt yuv420p -y "$MEDIA_SMOKE"
test "$(/usr/bin/ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name \
  -of default=noprint_wrappers=1:nokey=1 "$MEDIA_SMOKE")" = h264
rm -f "$MEDIA_SMOKE"
EOF
node packages/scripts/verify-packaged-cli.mjs \
  --expected "$(node -p "require('./packages/agent/package.json').version")" \
  --health-url http://127.0.0.1:43139/api/health \
  --isolation-root "$ISOLATION_ROOT/verifier" \
  --service-arg serve \
  -- flatpak --system run ai.elizaos.App
flatpak --system run --command=/bin/sh ai.elizaos.App -c \
  'test -f "$XDG_STATE_HOME/eliza/flatpak-persistence-smoke" && rm -f "$XDG_STATE_HOME/eliza/flatpak-persistence-smoke"'
```

## Flathub boundary

Do not submit either manifest to Flathub in its current form. A reviewable
submission must replace the ignored local `runtime/` source with immutable,
publicly fetchable sources whose checksums reproduce the same locked closure.
It also needs a native ARM64 build-and-boot lane before advertising that
architecture. The external FFmpeg extension supplies media tools but does not
make the application runtime remotely reproducible. The hardened manifest
records the intended permission posture, but permission shape alone does not
make a remotely reproducible store build.
