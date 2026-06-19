# Eliza — Package Publishing Guide

This guide covers the **human steps** required to publish Eliza across all five package managers. The packaging configs are ready — this document walks through account setup, credential configuration, and publishing commands.

---

## Table of Contents

1. [PyPI (eliza)](#1-pypi-eliza)
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

## 1. PyPI (eliza)

The `eliza` package on PyPI is a **dynamic loader** — a thin Python wrapper that auto-installs and delegates to the Node.js eliza CLI.

### 1.1 Account Setup (one-time)

1. **Create a PyPI account** at https://pypi.org/account/register/
2. **Enable 2FA** (required for new projects) at https://pypi.org/manage/account/two-factor/
3. **Create an API token**:
   - Go to https://pypi.org/manage/account/token/
   - Scope: "Entire account" (for first upload) or project-scoped after first publish
   - Save the token — it starts with `pypi-`
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
cd packaging/pypi

# Install build tools
pip install build twine

# Build the package
python -m build

# Upload to TestPyPI
twine upload --repository testpypi dist/*

# Test installation from TestPyPI
pip install --index-url https://test.pypi.org/simple/ eliza
eliza --help
```

### 1.3 Publish to PyPI

```bash
cd packaging/pypi

# Build
python -m build

# Upload (uses ~/.pypirc or TWINE env vars)
twine upload dist/*

# Verify
pip install eliza
eliza --version
```

### 1.4 Reserve the Package Name

If you want to claim the `eliza` name immediately before the full release:

```bash
cd packaging/pypi
python -m build
twine upload dist/*
```

The beta version (`2.0.0b0`) is fine for name reservation.

---

## 2. Homebrew

### 2.1 Create the Tap Repository (one-time)

A Homebrew "tap" is just a GitHub repo with a naming convention.

1. **Create a GitHub repo** named `homebrew-tap` under the `eliza-ai` org:
   - URL will be: `https://github.com/eliza-ai/homebrew-tap`

2. **Initialize the repo**:

```bash
# Clone and set up
git clone https://github.com/eliza-ai/homebrew-tap.git
cd homebrew-tap

# Copy the formula
mkdir -p Formula
cp /path/to/eliza/packaging/homebrew/eliza.rb Formula/eliza.rb
```

3. **Get the SHA256 hash** of the npm tarball:

```bash
# Download the tarball and compute hash
curl -fsSL "https://registry.npmjs.org/elizaos/-/elizaos-2.0.0-beta.0.tgz" -o eliza.tgz
shasum -a 256 eliza.tgz
# Replace PLACEHOLDER_SHA256 in eliza.rb with the actual hash
```

4. **Push the formula**:

```bash
git add Formula/eliza.rb
git commit -m "Add eliza formula"
git push origin main
```

### 2.2 Test the Formula

```bash
# Test locally before pushing
brew install --build-from-source Formula/eliza.rb

# Or after pushing to the tap repo
brew tap eliza-ai/tap
brew install eliza
```

### 2.3 Users Install With

```bash
brew tap eliza-ai/tap
brew install eliza
```

Or one-liner:

```bash
brew install eliza-ai/tap/eliza
```

### 2.4 Updating for New Releases

```bash
# Compute new SHA256
curl -fsSL "https://registry.npmjs.org/elizaai/-/elizaai-NEW_VERSION.tgz" -o eliza.tgz
shasum -a 256 eliza.tgz

# Update the formula: change url and sha256
# Push to homebrew-tap repo
```

---

## 3. apt (Debian/Ubuntu)

There are two approaches: a **PPA** (easier, Ubuntu-focused) or a **self-hosted apt repo** (works with all Debian-based distros).

### 3.1 Option A: Launchpad PPA (Ubuntu)

1. **Create a Launchpad account** at https://launchpad.net/+login
2. **Create a GPG key** and upload to Launchpad:

```bash
# Generate a GPG key
gpg --full-generate-key
# Choose RSA, 4096 bits, email matching your Launchpad account

# Upload to keyserver
gpg --send-keys YOUR_KEY_ID

# Add to Launchpad at https://launchpad.net/~/+editpgpkeys
```

3. **Create a PPA**:
   - Go to https://launchpad.net/~/+activate-ppa
   - Name: `eliza`
   - Display name: "Eliza — Personal AI Assistant"

4. **Build and upload the source package**:

```bash
cd /path/to/eliza

# Copy debian/ packaging into place
cp -r packaging/debian .

# Build the source package
dpkg-buildpackage -S -sa -k"YOUR_GPG_KEY_ID"

# Upload to PPA
dput ppa:YOUR_USERNAME/eliza ../eliza_2.0.0~beta0-1_source.changes
```

5. **Users install with**:

```bash
sudo add-apt-repository ppa:YOUR_USERNAME/eliza
sudo apt update
sudo apt install eliza
```

### 3.2 Option B: Self-Hosted apt Repository

This gives you more control and works across all Debian-based distros.

1. **Build the .deb package**:

```bash
cd /path/to/eliza
cp -r packaging/debian .

# Install build dependencies
sudo apt install debhelper nodejs npm

# Build the package
dpkg-buildpackage -us -uc -b

# The .deb will be in the parent directory
ls ../eliza_*.deb
```

2. **Set up a repo using GitHub Pages or a server**:

```bash
# Create repo structure
mkdir -p apt-repo/pool/main/m/eliza
mkdir -p apt-repo/dists/stable/main/binary-amd64

# Copy the .deb
cp ../eliza_*.deb apt-repo/pool/main/m/eliza/

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

3. **Host the repo** (GitHub Pages, S3, Cloudflare R2, etc.)

4. **Users install with**:

```bash
# Add the GPG key
curl -fsSL https://apt.eliza.ai/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/eliza.gpg

# Add the repo
echo "deb [signed-by=/usr/share/keyrings/eliza.gpg] https://apt.eliza.ai stable main" | \
  sudo tee /etc/apt/sources.list.d/eliza.list

sudo apt update
sudo apt install eliza
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
snapcraft register eliza
```

### 4.2 Build the Snap

```bash
cd /path/to/eliza

# Copy snapcraft.yaml into place
mkdir -p snap
cp packaging/snap/snapcraft.yaml snap/

# Build the snap (requires LXD or Multipass)
snapcraft

# This produces: eliza_2.0.0-beta.0_amd64.snap
```

### 4.3 Test Locally

```bash
# Install the local snap
sudo snap install eliza_*.snap --classic --dangerous

# Test
eliza --version
eliza --help
```

### 4.4 Publish to Snap Store

```bash
# Upload to edge channel first
snapcraft upload eliza_*.snap --release=edge

# After testing, promote to stable
snapcraft release eliza <revision> stable
```

### 4.5 Users Install With

```bash
sudo snap install eliza --classic
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
flatpak install flathub org.freedesktop.Platform//23.08
flatpak install flathub org.freedesktop.Sdk//23.08
```

3. **Create a Flathub account** (for Flathub distribution):
   - Submit at https://github.com/flathub/flathub/issues/new
   - Or self-host a Flatpak repo

### 5.2 Update SHA256 Hashes

Before building, you need the actual SHA256 hashes for the Node.js binaries:

```bash
# x86_64
curl -fsSL "https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz" -o node-x64.tar.xz
shasum -a 256 node-x64.tar.xz
# Replace PLACEHOLDER_SHA256_X64 in the manifest

# ARM64
curl -fsSL "https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-arm64.tar.xz" -o node-arm64.tar.xz
shasum -a 256 node-arm64.tar.xz
# Replace PLACEHOLDER_SHA256_ARM64 in the manifest
```

### 5.3 Build the Flatpak

```bash
cd packaging/flatpak

# Build
flatpak-builder --repo=repo build-dir ai.eliza.Eliza.yml

# Create a bundle for testing
flatpak build-bundle repo eliza.flatpak ai.eliza.Eliza
```

### 5.4 Test Locally

```bash
# Install from local bundle
flatpak --user install eliza.flatpak

# Run
flatpak run ai.eliza.Eliza --version
flatpak run ai.eliza.Eliza start
```

### 5.5 Publish to Flathub

1. Fork https://github.com/flathub/flathub
2. Create a new repo: `github.com/flathub/ai.eliza.Eliza`
3. Add the manifest and supporting files
4. Submit a PR — Flathub maintainers will review

### 5.6 Users Install With

```bash
flatpak install flathub ai.eliza.Eliza
flatpak run ai.eliza.Eliza start
```

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
keytool -genkeypair   -alias eliza-upload   -keyalg RSA -keysize 2048   -validity 10000   -keystore eliza-upload.jks   -storepass YOUR_STORE_PASSWORD   -dname "CN=Eliza AI, O=eliza-ai, L=Internet, C=US"
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

The repo now uses a two-stage release model:

1. **`agent-release.yml`** validates the heavy build matrix and publishes the GitHub Release only after the blocking lanes are green.
2. **`release-orchestrator.yml`** handles post-release distribution and fans out to reusable child workflows:
   - `publish-npm.yml`
   - `publish-packages.yml`
   - `android-release.yml`
   - `apple-store-release.yml`
   - `update-homebrew.yml`
   - `deploy-web.yml`

Why this split exists:

- A published GitHub Release is the single durable release event.
- Store-specific retries should not require retagging or rebuilding Electrobun.
- Stable vs pre-release routing differs by channel:
  - npm: `latest` for stable, `next` / `beta` / `nightly` for prereleases
  - Android: `production` for stable, `internal` for prereleases
  - Apple: `app-store` for stable, `testflight` for prereleases
  - Flatpak and Homebrew: stable-only by default

Manual recovery path:

```bash
# Re-run only the post-release distribution layer for an existing release
gh workflow run release-orchestrator.yml -f version=2.0.0-beta.0
```

### Required GitHub Secrets

| Secret | Where to get it | Used by |
|---|---|---|
| `SNAP_STORE_CREDENTIALS` | `snapcraft export-login --snaps=eliza --acls=package_push -` | Snap publishing |
| `HOMEBREW_TAP_TOKEN` | GitHub PAT with `repo` scope for `eliza-ai/homebrew-tap` | Homebrew formula updates |
| `PYPI_API_TOKEN` | https://pypi.org/manage/account/token/ (or use trusted publishing) | PyPI uploads |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 eliza-upload.jks` | Android AAB signing |
| `ANDROID_KEYSTORE_PASSWORD` | Android upload keystore password | Android AAB signing |
| `ANDROID_KEY_ALIAS` | Android upload key alias | Android AAB signing |
| `ANDROID_KEY_PASSWORD` | Android upload key password | Android AAB signing |
| `PLAY_STORE_SERVICE_ACCOUNT_JSON` | Google Cloud Console service account JSON (base64) | Play Store uploads |
| `APPLE_ID` | Apple ID email | Apple store publishing |
| `APPLE_TEAM_ID` | 10-char Apple team ID | Apple store publishing |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com | Apple store publishing |

### PyPI Trusted Publishing (recommended)

Instead of API tokens, use OIDC trusted publishing:
1. Go to https://pypi.org/manage/project/eliza/settings/publishing/
2. Add a "GitHub Actions" publisher:
   - Owner: `eliza-ai`
   - Repository: `eliza`
   - Workflow: `publish-packages.yml`
   - Environment: (leave blank or set one)

This eliminates the need for `PYPI_API_TOKEN` — GitHub Actions authenticates directly.

---

## 8. iOS App Store

### 8.1 Apple Developer Program (one-time)

1. **Enroll** at https://developer.apple.com/programs/ ($99/year)
2. **Create App ID**: Bundle ID `ai.eliza.app`, enable Push Notifications
3. **Create private certificates repo** `eliza-ai/certificates` for Fastlane Match
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
| `packaging/pypi/pyproject.toml` | `version` (use PEP 440: `2.0.0b0` not `2.0.0-beta.0`) |
| `packaging/pypi/eliza/__init__.py` | `__version__` |
| `packaging/snap/snapcraft.yaml` | `version` |
| `packaging/debian/changelog` | Add new entry at top |
| `packaging/homebrew/eliza.rb` | `url` + `sha256` (after npm publish) |
| `packaging/flatpak/ai.eliza.Eliza.metainfo.xml` | Add new `<release>` entry |
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
| **npm** | `npm install -g elizaai` |
| **PyPI** | `pip install eliza` |
| **Homebrew** | `brew install eliza-ai/tap/eliza` |
| **apt** | `sudo apt install eliza` (after adding repo) |
| **Snap** | `sudo snap install eliza --classic` |
| **Flatpak** | `flatpak install flathub ai.eliza.Eliza` |
| **Google Play** | Search "Eliza" on Play Store |
| **iOS App Store** | Search "Eliza" on App Store |
| **Mac App Store** | Search "Eliza" on Mac App Store |
| **npx** | `npx elizaai` (no install) |
| **pipx** | `pipx install eliza` |
