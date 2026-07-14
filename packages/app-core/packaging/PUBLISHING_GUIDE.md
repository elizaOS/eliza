# elizaOS package publishing guide

This guide covers the human steps required to publish elizaOS App packages,
including account setup, credential configuration, and reviewed commands.

---

## Table of Contents

1. [PyPI (elizaos-app)](#1-pypi-elizaos-app)
2. [Homebrew](#2-homebrew)
3. [apt (Debian/Ubuntu)](#3-apt-debianubuntu)
4. [Snap](#4-snap)
5. [Flatpak](#5-flatpak)
6. [Google Play Store (Android)](#6-google-play-store-android)
7. [CI/CD Automation](#7-cicd-automation)
8. [iOS App Store](#8-ios-app-store)
9. [Mac App Store](#9-mac-app-store)
10. [Version Bumping Checklist](#10-version-bumping-checklist)

---

## 1. PyPI (elizaos-app)

The `elizaos-app` package on PyPI is a dynamic loader that delegates to the
version-matched npm `elizaos` CLI. Node.js 24 or newer is required.

### 1.1 Account Setup (one-time)

1. **Create a PyPI account** at https://pypi.org/account/register/
2. **Enable 2FA** (required for new projects) at https://pypi.org/manage/account/two-factor/
3. **Create an API token**:
   - Go to https://pypi.org/manage/account/token/
   - The `elizaos-app` project does not exist until its first upload, so the
     first token must be account-wide and allowed to create the project
   - After that upload, revoke it and create a token scoped only to `elizaos-app`
   - Save the token — it starts with `pypi-`
   - Store the CI token as the `PYPI_TOKEN` GitHub Actions secret
4. **Configure credentials** locally:

```bash
# Option A: Using a ~/.pypirc file
cat > ~/.pypirc << 'EOF'
[distutils]
index-servers = pypi

[pypi]
username = __token__
password = pypi-YOUR_TOKEN_HERE
EOF
chmod 600 ~/.pypirc
```

```bash
# Option B: Environment variable (better for CI)
export TWINE_USERNAME=__token__
export TWINE_PASSWORD=pypi-YOUR_TOKEN_HERE
```

### 1.2 Test on TestPyPI First (recommended)

1. Create account at https://test.pypi.org/account/register/
2. Create API token at https://test.pypi.org/manage/account/token/

```bash
cd packages/app-core/packaging/pypi

# Install the reviewed, hash-locked build and validation tools
python -m pip install --require-hashes --requirement build-requirements.lock

# Build the package
python -m build --no-isolation
python verify_artifacts.py dist

# Upload to TestPyPI
python -m twine upload --repository testpypi dist/*

# Test installation from TestPyPI
pip install --index-url https://test.pypi.org/simple/ elizaos-app
elizaos-app --help
```

### 1.3 Publish to PyPI

```bash
cd packages/app-core/packaging/pypi

# Build
python -m pip install --require-hashes --requirement build-requirements.lock
python -m build --no-isolation
python verify_artifacts.py dist

# Upload (uses ~/.pypirc or TWINE env vars)
python -m twine upload dist/*

# Verify
pip install elizaos-app
elizaos-app --version
```

### 1.4 Reserve the Package Name

If you want to claim the `elizaos-app` name before the full release:

```bash
cd packages/app-core/packaging/pypi
python -m pip install --require-hashes --requirement build-requirements.lock
python -m build --no-isolation
python verify_artifacts.py dist
python -m twine upload dist/*
```

The beta version (`2.0.0b0`) is fine for name reservation.

---

## 2. Homebrew

The formula and cask are owned and tested in the authoritative
[`elizaOS/homebrew-tap`](https://github.com/elizaOS/homebrew-tap) repository.
This repository carries no versioned Ruby copies because a local syntax check
cannot prove that the external tap references the current release artifacts.

After a stable release and its exact npm prerequisite succeed,
`release-orchestrator.yml` calls `update-homebrew.yml`. The reusable workflow
requires `HOMEBREW_TAP_TOKEN`, accepts only exact stable semver, and sends an
`update-homebrew` repository-dispatch event with that version. The external tap
owns URL/digest generation, Node compatibility, installation, and audit tests.
Any missing credential or rejected dispatch fails the enabled Homebrew job and
therefore the distribution summary.

Users install with:

```bash
brew tap elizaOS/tap
brew install elizaos-app
brew install --cask elizaos-app
```

---

## 3. apt (Debian/Ubuntu)

The Debian package contains the same production-only runtime used by Snap and
Flatpak. Prepare it from the exact release checkout before invoking Debian's
build boundary; `debian/rules` performs no registry install and rejects a
missing runtime. The release workflow is the canonical amd64 builder because
the locked automation dependency contains an x86-only Linux native payload.
The package also embeds the complete, official Node.js v24.15.0 Linux x64
distribution. Its archive, executable, and corresponding source archive are
content-pinned by `packages/scripts/locked-node-runtime.mjs`; the launcher uses
that runtime by absolute path and puts its toolchain first for child processes,
so users do not add NodeSource or install a system `nodejs` package. The full
upstream license, bundled-dependency notices, and generated provenance remain
in the runtime and `/usr/share/doc`.
The elizaOS project license is copied byte-for-byte from the repository root,
and `generate-license-inventory.mjs` derives `THIRD_PARTY_NOTICES.json` from the
assembler's hashed `elizaos-runtime-dependencies.json` and the installed
manifests. It verifies the frozen Bun source-lock digest, exact package set,
manifest and payload hashes, retains every package-local license and notice
byte, and classifies SPDX choices as `allow`, `obligation-reviewed`, or
`prohibited`. Known network-copyleft, non-commercial, and source-available
terms fail the build; missing or file-referenced declarations stay visible in
the obligation-bearing class. Reviewed evidence fills npm tarball omissions,
and the rpc-websockets entry includes the upstream notice, complete LGPLv3 and
GPLv3 texts, pinned source, and relinking instructions. The installed copies live at
`/usr/share/doc/elizaos-app/elizaos-LICENSE` and
`/usr/share/doc/elizaos-app/third-party-notices.json`; they are separate from
Node's upstream legal files.
The prepared npm closure retains the `ffmpeg-static` and `ffprobe-static`
JavaScript adapters but excludes their executable payloads. Debian supplies
both media tools through its separately distributed `ffmpeg` package, and the
launcher pins every supported FFmpeg environment variable to `/usr/bin`.
Debian's archive therefore remains the source and license-compliance boundary
for the FFmpeg binaries rather than the elizaOS `.deb` redistributing them.
Each Debian lane extracts the finished `.deb` and rejects any file or symlink
whose basename is `ffmpeg`, `ffprobe`, or a Windows `.exe` variant before the
package can be installed or attached to a release.

The background unit is a systemd user service. `dh_installsystemduser` installs
it and generates the package-state-aware maintainer-script paths: a previously
enabled service remains enabled across upgrades, a disabled service remains
disabled, and purge removes the helper state. Package installation does not
try to contact a user session bus from the root-owned dpkg process, so users
start the service explicitly with `systemctl --user enable --now elizaos-app`.
Every Debian build extracts the finished control archive with
`verify-maintainer-scripts.sh` and checks those exact generated paths before the
artifact can be installed, uploaded, or released.

### 3.1 Build and verify the binary package

1. **Build the .deb package**:

```bash
cd /path/to/eliza
sudo apt install ca-certificates curl debhelper devscripts dpkg-dev fakeroot xz-utils
test "$(node --version)" = v24.15.0
test "$(bun --version)" = 1.4.0
bun run install:light
node packages/scripts/run-turbo.mjs run build \
  --filter=@elizaos/agent... --concurrency=8
node packages/scripts/prepare-packaged-runtime.mjs \
  --source-root . \
  --destination-root packages/app-core/packaging/debian/runtime \
  --entry @elizaos/agent
node packages/app-core/packaging/generate-license-inventory.mjs \
  packages/app-core/packaging/debian/runtime
node packages/scripts/locked-node-runtime.mjs \
  packages/app-core/packaging/debian/node-runtime
test ! -e debian
install -d debian
git archive --format=tar HEAD packages/app-core/packaging/debian | \
  tar --extract --directory=debian --strip-components=4
test ! -e debian/runtime
test ! -e debian/node-runtime

dpkg-buildpackage -us -uc -b
mapfile -t DEBS < <(find .. -maxdepth 1 -type f -name 'elizaos-app_*.deb' \
  ! -name '*-dbgsym_*' -print)
test "${#DEBS[@]}" -eq 1
DEB_PATH="$(realpath "${DEBS[0]}")"
bash packages/app-core/packaging/debian/verify-maintainer-scripts.sh \
  "$DEB_PATH"
DEB_DEPENDS="$(dpkg-deb -f "$DEB_PATH" Depends)"
! grep -Eq '(^|[,[:space:]])nodejs([,[:space:]()]|$)' <<< "$DEB_DEPENDS"
grep -Eq '(^|,[[:space:]]*)libc6([[:space:],(]|$)' <<< "$DEB_DEPENDS"
grep -Eq '(^|,[[:space:]]*)libstdc\+\+6([[:space:],(]|$)' <<< "$DEB_DEPENDS"
sudo apt install "$DEB_PATH"
BUNDLED_NODE=/usr/lib/elizaos-app/node/bin/node
test "$("$BUNDLED_NODE" --version)" = v24.15.0
printf '%s  %s\n' \
  d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c \
  "$BUNDLED_NODE" | sha256sum -c -
test -s /usr/lib/elizaos-app/node/LICENSE
test -s /usr/lib/elizaos-app/node/elizaos-runtime-provenance.json
test -L /usr/lib/elizaos-app/node/bin/npm
test -f /usr/lib/elizaos-app/node/include/node/node.h
test -f /usr/lib/elizaos-app/node/lib/node_modules/npm/package.json
cmp /usr/lib/elizaos-app/node/LICENSE \
  /usr/share/doc/elizaos-app/nodejs-LICENSE
cmp /usr/lib/elizaos-app/node/elizaos-runtime-provenance.json \
  /usr/share/doc/elizaos-app/nodejs-runtime-provenance.json
test "$(sha256sum /usr/share/doc/elizaos-app/elizaos-LICENSE | cut -d ' ' -f 1)" = \
  d0590837a439c742e89c8226137dd4e902fa1e0df486347dbfc9b8ba68b5826d
cmp /usr/lib/elizaos-app/LICENSE \
  /usr/share/doc/elizaos-app/elizaos-LICENSE
cmp /usr/lib/elizaos-app/THIRD_PARTY_NOTICES.json \
  /usr/share/doc/elizaos-app/third-party-notices.json
"$BUNDLED_NODE" --input-type=module <<'NODE_PROVENANCE'
import { readFileSync } from "node:fs";
const provenance = JSON.parse(readFileSync(
  "/usr/lib/elizaos-app/node/elizaos-runtime-provenance.json",
  "utf8",
));
if (
  provenance.version !== "24.15.0" ||
  provenance.platform !== "linux-x64" ||
  provenance.archiveSha256 !== "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6" ||
  provenance.executableSha256 !== "d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c" ||
  provenance.source?.sha256 !== "a4f653d79ed140aaad921e8c22a3b585ca85cfdab80d4030f6309e4663a8a1c8"
) {
  throw new Error(`Unexpected installed Node.js provenance: ${JSON.stringify(provenance)}`);
}
NODE_PROVENANCE
MEDIA_SMOKE="$(mktemp --suffix=.mp4)"
/usr/bin/ffmpeg -hide_banner -loglevel error \
  -f lavfi -i color=c=black:s=16x16:d=0.04 \
  -c:v libx264 -pix_fmt yuv420p -y "$MEDIA_SMOKE"
test "$(/usr/bin/ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name \
  -of default=noprint_wrappers=1:nokey=1 "$MEDIA_SMOKE")" = h264
rm -f "$MEDIA_SMOKE"
EXPECTED_VERSION="$(node -p "require('./packages/agent/package.json').version")"
test "$(PATH=/nonexistent /usr/bin/elizaos-app --version)" = "$EXPECTED_VERSION"
PATH=/usr/bin:/bin "$BUNDLED_NODE" packages/scripts/verify-packaged-cli.mjs \
  --expected "$EXPECTED_VERSION" \
  --health-url http://127.0.0.1:43138/api/health \
  --service-arg serve \
  -- /usr/bin/elizaos-app
```

### 3.2 Self-hosted apt repository

The automated publisher imports the dedicated signing key into a unique,
empty `GNUPGHOME` for each run. `DEBIAN_GPG_KEY_ID` must contain the complete
40-hex primary-key fingerprint, not a short or long key ID. The checked-in
`SignWith: default` values are templates only: the workflow replaces every one
with that exact fingerprint before invoking `reprepro`, rejects any remaining
`default`, and exports only the matching public key.

There is one automated repository writer: `publish-packages.yml` attaches the
verified `.deb` to the GitHub Release, then its `publish-apt` job calls the
in-repo `publish-apt-repo.yml` reusable workflow. That workflow serializes all
writers and commits the signed repository to this repository's `apt-repo`
branch. It does not dispatch a second repository. A retry with the same
package/version/architecture skips only when the existing pool `.deb` has the
same SHA-256; different bytes fail the release. Even an identical retry
re-exports every configured distribution so a changed signing key or repository
configuration cannot strand the other channel with stale metadata signatures.

Two release paths reach package distribution today: the tag-triggered
`release-all.yml` pipeline (which prepares the GitHub release, runs the
platform builds, and calls the snap/apt/flatpak publishers directly) and the
published-release event handled by `release-orchestrator.yml`, which calls
`publish-packages.yml`. In both paths `build-debian-package.yml` is a
build-and-installed-smoke gate and never attaches release assets; the `.deb`
release attachment lives only in `publish-packages.yml`, after the installed
smoke passes. Byte-idempotent attachment and pool checks make retries safe:
an identical retry skips, different bytes fail, so a draft-time `edge` upload
cannot be silently replaced by a second `beta` upload
for the same prerelease.

The branch update is not proof that the public endpoint is live. At the time
of this review, `apt.elizaos.ai` has no DNS record. Before enabling apt in a
release, an owner must configure GitHub Pages to serve the `apt-repo` branch,
prove control of the `apt.elizaos.ai` DNS record, and manually verify the
published `InRelease`, `Release.gpg`, `Packages`, and `gpg.key` over HTTPS.

1. **Set up a repo using GitHub Pages or a server**:

```bash
# Create repo structure
mkdir -p apt-repo/pool/main/e/elizaos-app
mkdir -p apt-repo/dists/stable/main/binary-amd64

# Copy the .deb
cp ../elizaos-app_*.deb apt-repo/pool/main/e/elizaos-app/

# Generate Packages index
cd apt-repo
dpkg-scanpackages pool/ /dev/null | gzip -9c > dists/stable/main/binary-amd64/Packages.gz
dpkg-scanpackages pool/ /dev/null > dists/stable/main/binary-amd64/Packages

# Create Release file
cd dists/stable
apt-ftparchive release . > Release

# Sign with GPG
gpg --armor --detach-sign -o Release.gpg Release
gpg --armor --clearsign -o InRelease Release
```

2. **Host the repo** (GitHub Pages, S3, Cloudflare R2, etc.)

The automated publisher accepts exactly one main `.deb` and inspects its
`Package`, `Architecture`, and Debian `Version` fields before `reprepro` can
index it. The expected version is derived from the validated release input
(`beta.N`/`rc.N` become `~betaN`/`~rcN`, with Debian revision `-1`). Its
isolated GnuPG and download tree is removed on every job outcome so signing
keys and release artifacts do not persist on a self-hosted runner. Before
`reprepro` runs, the workflow performs a loopback detached-signature probe with
the optional passphrase. That probe either unlocks the isolated agent or fails
promptly; `reprepro --ask-passphrase` is not used because it does not read the
secret from standard input.

3. **Users install with**:

```bash
# Add the GPG key
curl -fsSL https://apt.elizaos.ai/gpg.key | \
  sudo gpg --dearmor -o /usr/share/keyrings/elizaos.gpg

# Add the repo
echo "deb [signed-by=/usr/share/keyrings/elizaos.gpg] https://apt.elizaos.ai stable main" | \
  sudo tee /etc/apt/sources.list.d/elizaos.list

sudo apt update
sudo apt install elizaos-app
```

---

## 4. Snap

### 4.1 Account Setup (one-time)

1. **Create a Snapcraft account** at https://snapcraft.io/account
   - Uses Ubuntu One SSO
2. **Install snapcraft**:

```bash
sudo snap install snapcraft --classic
```

3. **Login**:

```bash
snapcraft login
```

4. **Register the snap name**:

```bash
snapcraft register elizaos-app
snap info elizaos-app
```

`elizaos-app` is currently not returned by the public Snap Store lookup. A
maintainer must reserve and confirm the name before CI publishing; the release
credential intentionally has no package-registration authority.

### 4.2 Build the Snap

The Snap is an amd64 package. Its locked automation dependency currently ships
an x86-only Linux native payload, so the workflow and manifest do not advertise
an ARM64 artifact that cannot boot the same production closure.

FFmpeg is not embedded in the app snap. The top-level `ffmpeg-2204` content plug
mounts the separately published provider at `$SNAP/ffmpeg-platform`; the app
environment pins FFmpeg and ffprobe to that mount and includes its amd64 library
directory in the dynamic-loader path. The provider publisher and Snap Store
distribution are the source-compliance boundary for those binaries. Because
Snapcrafters publishes the provider, this cross-publisher content plug does not
auto-connect without Snap Store approval. The build tests connect it explicitly;
a clean Store install must keep doing so until an approved auto-connect assertion
is proven in a post-publication smoke. After Snapcraft builds the artifact, each
lane extracts the final SquashFS payload and repeats the FFmpeg/ffprobe
no-conveyance check before installing it.

There is one Snap Store writer: `publish-packages.yml` delegates automatic
post-release publication to the reusable `snap-publish.yml` workflow, and
manual recovery invokes that same workflow. Its repository-wide concurrency
gate serializes all channels so two runs cannot publish competing revisions or
route the same prerelease to different channels.

```bash
cd /path/to/eliza

# Build and prepare the native production runtime first.
bun run install:light
node packages/scripts/run-turbo.mjs run build \
  --filter=@elizaos/agent... --concurrency=8
node packages/scripts/prepare-packaged-runtime.mjs \
  --source-root . \
  --destination-root packages/app-core/packaging/snap/runtime \
  --entry @elizaos/agent
node packages/app-core/packaging/generate-license-inventory.mjs \
  packages/app-core/packaging/snap/runtime

mkdir -p snap
cp packages/app-core/packaging/snap/snapcraft.yaml snap/

# Build the snap (requires LXD or Multipass)
snapcraft

# This produces an architecture-specific elizaos-app snap.
```

The snap installs the byte-identical project license and generated dependency
inventory at `/usr/share/licenses/elizaos-app/LICENSE` and
`/usr/share/licenses/elizaos-app/THIRD_PARTY_NOTICES.json`. Runtime state uses
the canonical `ELIZA_STATE_DIR=$SNAP_USER_COMMON/state/eliza` contract. Its XDG
config, data, and state roots all use `$SNAP_USER_COMMON`, so revisions share
persistent application state without a second snap-specific data path.

### 4.3 Test Locally

```bash
# Install and connect the external FFmpeg provider before the local app snap.
sudo snap install ffmpeg-2204
sudo snap install elizaos-app_*.snap --dangerous
sudo snap connect elizaos-app:ffmpeg-2204 ffmpeg-2204:ffmpeg-2204

# Test the provider from inside the confined app environment.
sudo snap run --shell elizaos-app <<'EOF'
set -eu
test "$(sha256sum "$SNAP/usr/share/licenses/elizaos-app/LICENSE" | cut -d ' ' -f 1)" = d0590837a439c742e89c8226137dd4e902fa1e0df486347dbfc9b8ba68b5826d
test -s "$SNAP/usr/share/licenses/elizaos-app/THIRD_PARTY_NOTICES.json"
test "$ELIZA_STATE_DIR" = "$SNAP_USER_COMMON/state/eliza"
test "$(command -v ffmpeg)" = "$SNAP/ffmpeg-platform/usr/bin/ffmpeg"
test "$(command -v ffprobe)" = "$SNAP/ffmpeg-platform/usr/bin/ffprobe"
MEDIA_SMOKE="$SNAP_USER_COMMON/ffmpeg-smoke-$$.mp4"
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i color=c=black:s=16x16:d=0.04 \
  -c:v libx264 -pix_fmt yuv420p -y "$MEDIA_SMOKE"
test "$(ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name \
  -of default=noprint_wrappers=1:nokey=1 "$MEDIA_SMOKE")" = h264
rm -f "$MEDIA_SMOKE"
mkdir -p "$ELIZA_STATE_DIR"
: > "$ELIZA_STATE_DIR/publishing-guide-persistence-smoke"
EOF

# A second confined launch must observe the same persistent state root.
sudo snap run --shell elizaos-app <<'EOF'
set -eu
test -f "$ELIZA_STATE_DIR/publishing-guide-persistence-smoke"
rm -f "$ELIZA_STATE_DIR/publishing-guide-persistence-smoke"
EOF

# Test the app.
elizaos-app --version
elizaos-app --help
```

### 4.4 Publish to Snap Store

```bash
# Upload to edge channel first
snapcraft upload elizaos-app_*.snap --release=edge

# After testing, promote to stable
snapcraft release elizaos-app <revision> stable
```

### 4.5 Users Install With

```bash
sudo snap install ffmpeg-2204
sudo snap install elizaos-app
sudo snap connect elizaos-app:ffmpeg-2204 ffmpeg-2204:ffmpeg-2204
elizaos-app serve
```

---

## 5. Flatpak

### 5.1 Setup (one-time)

1. **Install Flatpak build tools**:

```bash
# Debian/Ubuntu
sudo apt install flatpak flatpak-builder

# Fedora
sudo dnf install flatpak flatpak-builder
```

2. **Install the SDK**:

```bash
sudo flatpak install --system flathub org.freedesktop.Platform//24.08
sudo flatpak install --system flathub org.freedesktop.Sdk//24.08
sudo flatpak install --system flathub org.freedesktop.Platform.ffmpeg-full//24.08
```

The current manifests produce x86_64 side-load bundles. They consume a native,
generated runtime that is ignored by git and are not Flathub submission
manifests. Their prepared npm closure contains no FFmpeg or ffprobe executable.
The separately distributed Freedesktop 24.08 runtime and
`org.freedesktop.Platform.ffmpeg-full` extension provide `/usr/bin/ffmpeg`,
`/usr/bin/ffprobe`, and the full codec libraries. Freedesktop/Flathub remains
the source and license-compliance boundary for that media stack. The build
lanes check out the final application OSTree commit and scan only its `files/`
tree (the future `/app`), rejecting media executables without confusing the
separate platform `/usr` provider for app-owned content.
Both profiles install the byte-identical project license at
`/app/share/licenses/ai.elizaos.App/elizaos-LICENSE` and the artifact-derived
dependency inventory at
`/app/share/licenses/ai.elizaos.App/third-party-notices.json`. Flatpak's
per-application XDG directories persist without a broad host grant; the
launcher binds the canonical `ELIZA_STATE_DIR` contract to
`$XDG_STATE_HOME/eliza`. The store profile therefore needs neither the stale
`.eliza` persistence mapping nor host config-directory access.

### 5.2 Update SHA256 Hashes

Before building, you need the actual SHA256 hashes for the Node.js binaries:

```bash
# x86_64
curl -fsSL "https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz" -o node-x64.tar.xz
shasum -a 256 node-x64.tar.xz
# Confirm the digest matches the x86_64 source in both manifests.
```

### 5.3 Build the Flatpak

```bash
cd /path/to/eliza

# Build the direct side-load bundle, including the locked runtime preparation.
bun run --cwd packages/app-core build:flatpak:direct

# Bundle output:
ls -l dist-flatpak/elizaos-app.flatpak
```

### 5.4 Test Locally

```bash
# Install from local bundle
sudo flatpak --system install dist-flatpak/elizaos-app.flatpak

# Prove the locked Node distribution and full-codec extension are installed.
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
test -s "$THIRD_PARTY_NOTICES"
test "$ELIZA_STATE_DIR" = "$XDG_STATE_HOME/eliza"
MEDIA_SMOKE="/tmp/elizaos-ffmpeg-smoke-$$.mp4"
/usr/bin/ffmpeg -hide_banner -loglevel error \
  -f lavfi -i color=c=black:s=16x16:d=0.04 \
  -c:v libx264 -pix_fmt yuv420p -y "$MEDIA_SMOKE"
test "$(/usr/bin/ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name \
  -of default=noprint_wrappers=1:nokey=1 "$MEDIA_SMOKE")" = h264
rm -f "$MEDIA_SMOKE"
/usr/bin/mkdir -p "$ELIZA_STATE_DIR"
: > "$ELIZA_STATE_DIR/publishing-guide-persistence-smoke"
EOF

# A second sandbox launch must see the same per-app XDG state.
sudo flatpak --system run --command=/bin/sh ai.elizaos.App -c \
  'test -f "$XDG_STATE_HOME/eliza/publishing-guide-persistence-smoke" && rm -f "$XDG_STATE_HOME/eliza/publishing-guide-persistence-smoke"'
flatpak --system run ai.elizaos.App --version
flatpak --system run ai.elizaos.App serve
```

### 5.5 Distribution boundary

Attach the reviewed x86_64 bundle to the matching GitHub Release. Do not claim
Flathub availability until the generated `runtime/` source is replaced by
immutable public sources and a native ARM64 build-and-boot lane exists. The
separately installed FFmpeg extension does not change this side-load-only
status. `flatpak-publish.yml` never talks to Flathub: it delegates to
`publish-packages.yml`, which builds, installs, and smoke-tests the bundle
from the exact release tag before attaching it to the GitHub release, so no
missing listing or credential is translated into success. A
release retry downloads an existing canonical bundle and skips only when its
SHA-256 is identical; different bytes fail without replacing the asset.

---


## 6. Google Play Store (Android)

### 6.1 Account Setup (one-time)

1. **Create a Google Play Developer account** at https://play.google.com/console/signup
   - One-time $25 registration fee
   - Requires identity verification

2. **Create the app listing**:
   - Go to Google Play Console → "Create app"
   - App name: "Eliza"
   - Default language: English (United States)
   - App type: App
   - Free / Paid: Free

3. **Set up Google Play App Signing**:
   - Go to Release → Setup → App signing
   - Choose "Let Google manage and protect your app signing key" (recommended)
   - Generate an **upload keystore** for CI:

```bash
keytool -genkeypair   -alias eliza-upload   -keyalg RSA -keysize 2048   -validity 10000   -keystore eliza-upload.jks   -storepass YOUR_STORE_PASSWORD   -dname "CN=Eliza AI, O=elizaOS, L=Internet, C=US"
```

4. **Upload the upload key certificate** to Play Console:

```bash
keytool -export -alias eliza-upload   -keystore eliza-upload.jks   -rfc > eliza-upload-cert.pem
```

Upload `eliza-upload-cert.pem` in Play Console → App signing.

5. **Create a service account for CI**:
   - Go to Play Console → Setup → API access
   - Link to Google Cloud project
   - Create a service account with "Release manager" role
   - Download the JSON key file

### 6.2 Required GitHub Secrets

| Secret | Description |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 eliza-upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | `eliza-upload` |
| `ANDROID_KEY_PASSWORD` | Key password |
| `PLAY_STORE_SERVICE_ACCOUNT_JSON` | `base64 -w0 play-store-key.json` |

### 6.3 Build the AAB Locally

```bash
cd apps/app

# Build web assets
bun run build

# Sync to Android
npx cap sync android

# Build signed AAB
cd android
ELIZA_KEYSTORE_PATH=/path/to/eliza-upload.jks ELIZA_KEYSTORE_PASSWORD=yourpass ELIZA_KEY_ALIAS=eliza-upload ELIZA_KEY_PASSWORD=yourpass ./gradlew bundleRelease

# AAB is at app/build/outputs/bundle/release/app-release.aab
```

### 6.4 Publish via Fastlane

```bash
cd apps/app/android

# Install Fastlane
bundle install

# Upload to internal testing
PLAY_STORE_JSON_KEY=/path/to/play-store-key.json ELIZA_KEYSTORE_PATH=/path/to/eliza-upload.jks ELIZA_KEYSTORE_PASSWORD=yourpass ELIZA_KEY_ALIAS=eliza-upload ELIZA_KEY_PASSWORD=yourpass bundle exec fastlane internal

# Promote to beta
bundle exec fastlane beta

# Promote to production
bundle exec fastlane production
```

### 6.5 Store Listing Checklist

Complete these in Play Console before first release:

- [ ] App name and description (`fastlane/metadata/android/en-US/`)
- [ ] Feature graphic (1024x500px)
- [ ] App icon (512x512px)
- [ ] Phone screenshots (minimum 2, 16:9 or 9:16)
- [ ] Privacy policy URL
- [ ] Data safety section (declare: network access, API keys stored locally)
- [ ] Content rating (IARC questionnaire)
- [ ] Target audience declaration
- [ ] App category: Tools → Productivity

### 6.6 Data Safety Declarations

| Question | Answer |
|---|---|
| Does the app collect data? | Yes (user-provided API keys, chat messages) |
| Is data shared with third parties? | Yes (AI providers: Anthropic, OpenAI, etc. — user-selected) |
| Is data encrypted in transit? | Yes (HTTPS to all AI providers) |
| Can users request data deletion? | Yes (local data, users delete the app or clear data) |
| Data stored on device | API keys, chat history, agent configuration |
| Data sent to servers | Chat messages to user-selected AI provider |

## 7. CI/CD Automation

### GitHub Actions release topology

The repo uses a tag-driven release pipeline plus event-driven package
distribution:

1. **`release-all.yml`** fires on `v*.*.*` tag pushes (or manual dispatch),
   validates the version, creates or reuses a draft GitHub Release, runs the
   platform builds, and calls the Linux package lanes: `build-debian-package.yml`
   (build + installed smoke, artifact upload only), `snap-publish.yml`,
   `publish-apt-repo.yml`, and `flatpak-publish.yml` (which delegates to the
   verified `publish-packages.yml` side-load bundle job). Its summary can
   flip the draft public when the matrix succeeds.
2. **`release.yaml`** owns npm publication: it fires on exact beta-tag pushes
   and on GitHub release creation.
3. **`release-orchestrator.yml`** fires on `release: published` and owns
   post-release package distribution through `publish-packages.yml`
   (PyPI, Snap, Debian + APT, Flatpak side-load bundle), plus
   `update-homebrew.yml` and homepage deployment.

Why this split exists:

- Store-specific retries should not require retagging or rebuilding Electrobun.
- Stable vs pre-release routing differs by channel:
  - npm: `latest` for stable, `beta` from exact beta-tag pushes
  - Android: `production` for stable, `internal` for prereleases
  - Apple: `app-store` for stable, `testflight` for prereleases
  - Flatpak: x86_64 side-load bundle when the package toggle is enabled
  - Homebrew: stable-only by default

Every publisher in `publish-packages.yml` checks out the
exact validated release tag and verifies that its peeled commit is `HEAD`
before building. Publication is
serialized by a repository-wide concurrency gate so retrying one format cannot
race a different release. No nightly format exists for these system packages:
nightly npm builds never enter the Debian, APT, Snap, or Flatpak channels.

Manual recovery path:

```bash
# Re-run only the post-release distribution layer for an existing release
gh workflow run release-orchestrator.yml -f version=2.0.0-beta.0
```

### Required GitHub Secrets

| Secret | Where to get it | Used by |
|---|---|---|
| `SNAPCRAFT_STORE_CREDENTIALS` | `snapcraft export-login --snaps elizaos-app --channels edge,beta,candidate,stable --acls package_access,package_push,package_update,package_release -` | Snap publishing |
| `HOMEBREW_TAP_TOKEN` | GitHub PAT with `repo` scope for `elizaOS/homebrew-tap` | Homebrew formula updates |
| `PYPI_TOKEN` | Account-wide token for the first upload; then rotate to a project-scoped token from https://pypi.org/manage/project/elizaos-app/settings/ | PyPI uploads |
| `DEBIAN_GPG_PRIVATE_KEY` | Dedicated armored secret key exported for the apt repository | apt metadata signing |
| `DEBIAN_GPG_KEY_ID` | Exact 40-hex primary fingerprint of `DEBIAN_GPG_PRIVATE_KEY` | Selects the only allowed apt signing identity |
| `DEBIAN_GPG_PASSPHRASE` | Passphrase chosen for the dedicated apt signing key, when present | Unlocks apt signing |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 eliza-upload.jks` | Android AAB signing |
| `ANDROID_KEYSTORE_PASSWORD` | Android upload keystore password | Android AAB signing |
| `ANDROID_KEY_ALIAS` | Android upload key alias | Android AAB signing |
| `ANDROID_KEY_PASSWORD` | Android upload key password | Android AAB signing |
| `PLAY_STORE_SERVICE_ACCOUNT_JSON` | Google Cloud Console service account JSON (base64) | Play Store uploads |
| `APPLE_ID` | Apple ID email | Apple store publishing |
| `APPLE_TEAM_ID` | 10-char Apple team ID | Apple store publishing |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com | Apple store publishing |

### PyPI authentication for the reusable workflow

`publish-packages.yml` runs through `workflow_call`. PyPI's GitHub trusted
publisher cannot authenticate this reusable-workflow call path, so this lane
does not request an OIDC token. Configure a project-scoped token for the
[`elizaos-app` project](https://pypi.org/manage/project/elizaos-app/settings/)
as the `PYPI_TOKEN` Actions secret. The job fails before checkout when it is
missing, passes it only to the content-pinned PyPI publish action, and disables
that action's OIDC-backed attestations. Before the project exists, use an
account-wide token that can create it for the first upload, then revoke and
replace that credential with the project-scoped token.

---

## 8. iOS App Store

### 8.1 Apple Developer Program (one-time)

1. **Enroll** at https://developer.apple.com/programs/ ($99/year)
2. **Create App ID**: Bundle ID `ai.eliza.app`, enable Push Notifications
3. **Create private certificates repo** `elizaOS/certificates` for Fastlane Match
4. **Create App Store Connect app**: Platform iOS, Bundle ID `ai.eliza.app`

### 8.2 Required GitHub Secrets

| Secret | Description |
|---|---|
| `APPLE_ID` | Apple ID email |
| `APPLE_TEAM_ID` | 10-char Apple Developer Team ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | Generated at appleid.apple.com |
| `ITC_TEAM_ID` | App Store Connect team ID |
| `APP_STORE_APP_ID` | Numeric Apple ID from App Store Connect |
| `MATCH_PASSWORD` | Encryption password for Match certificates |
| `MATCH_GIT_URL` | URL to certificates repo |
| `MATCH_GIT_BASIC_AUTHORIZATION` | base64(username:PAT) for certificates repo |

### 8.3 App Privacy Nutrition Labels

| Data Type | Collected | Linked to Identity | Tracking |
|---|---|---|---|
| Usage Data | Yes | No | No |
| Location | Yes (optional) | No | No |
| Photos | Yes (optional) | No | No |
| User Content (chat) | Yes | No | No |

Data is stored on-device only. Chat messages sent to user-selected AI provider.


## 9. Mac App Store

### 9.1 Additional Secrets

| Secret | Description |
|---|---|
| `MAS_CSC_LINK` | base64-encoded Apple Distribution .p12 |
| `MAS_CSC_KEY_PASSWORD` | Password for the .p12 |
| `MAS_INSTALLER_CERT` | base64-encoded 3rd Party Mac Developer Installer .p12 |
| `MAS_INSTALLER_KEY_PASSWORD` | Password for installer .p12 |
| `APP_STORE_API_KEY_ID` | App Store Connect API key ID |
| `APP_STORE_API_ISSUER_ID` | App Store Connect API issuer ID |

### 9.2 Sandboxing

Mac App Store requires App Sandbox. Entitlements at
`apps/app/electrobun/entitlements/mas.entitlements` configure network,
file access, camera, microphone, and JIT compilation for Bun runtime.

## 10. Version Bumping Checklist

When releasing a new version, update these files:

| File | Field to Update |
|---|---|
| `package.json` | `version` |
| `packages/app-core/packaging/pypi/pyproject.toml` | `version` (use PEP 440: `2.0.0b0` not `2.0.0-beta.0`) |
| `packages/app-core/packaging/pypi/elizaos_app/__init__.py` | `__version__` |
| `packages/app-core/packaging/snap/snapcraft.yaml` | `version` |
| `packages/app-core/packaging/debian/changelog` | Add new entry at top |
| `elizaOS/homebrew-tap` (external) | Formula/cask are updated by the stable release dispatch |
| `packages/app-core/packaging/flatpak/ai.elizaos.App.metainfo.xml` | Add new `<release>` entry |
| `apps/app/android/app/build.gradle` | `versionCode` + `versionName` (via env vars in CI) |

### Version Format Mapping

| Platform | Format | Example |
|---|---|---|
| npm | semver pre-release | `2.0.0-beta.0` |
| PyPI (PEP 440) | beta suffix | `2.0.0b0` |
| Debian | tilde for pre-release | `2.0.0~beta0-1` |
| Snap | semver-ish | `2.0.0-beta.0` |
| Flatpak | semver | `2.0.0-beta.0` |
| Homebrew | follows npm tarball URL | (automatic) |

---

## Quick Reference: User Install Commands

| Platform | Command |
|---|---|
| **npm** | `npm install -g elizaos` |
| **PyPI** | `pip install elizaos-app` |
| **Homebrew** | `brew install elizaOS/tap/elizaos-app` |
| **apt** | `sudo apt install elizaos-app` (after adding repo) |
| **Snap** | `sudo snap install ffmpeg-2204 && sudo snap install elizaos-app && sudo snap connect elizaos-app:ffmpeg-2204 ffmpeg-2204:ffmpeg-2204` |
| **Flatpak** | Install the x86_64 bundle attached to the GitHub Release |
| **Google Play** | Search "Eliza" on Play Store |
| **iOS App Store** | Search "Eliza" on App Store |
| **Mac App Store** | Search "Eliza" on Mac App Store |
| **npx** | `npx elizaos` (no install) |
| **pipx** | `pipx install elizaos-app` |
