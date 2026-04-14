<<<<<<< HEAD
# elizaOS App — Package Publishing Guide

This guide covers the **human steps** required to publish an elizaOS app across all five package managers. The packaging configs are ready — this document walks through account setup, credential configuration, and publishing commands.
=======
# Milady — Package Publishing Guide

This guide covers the **human steps** required to publish Milady across all five package managers. The packaging configs are ready — this document walks through account setup, credential configuration, and publishing commands.
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

---

## Table of Contents

<<<<<<< HEAD
1. [PyPI](#1-pypi-elizaos-app)
=======
1. [PyPI (milady)](#1-pypi-milady)
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
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

<<<<<<< HEAD
## 1. PyPI

The app package on PyPI is a **dynamic loader** — a thin Python wrapper that auto-installs and delegates to the Node.js elizaOS CLI.
=======
## 1. PyPI (milady)

The `milady` package on PyPI is a **dynamic loader** — a thin Python wrapper that auto-installs and delegates to the Node.js milady CLI.
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

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
<<<<<<< HEAD
pip install elizaos-app
elizaos-app --help
=======
pip install --index-url https://test.pypi.org/simple/ milady
milady --help
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

### 1.3 Publish to PyPI

```bash
cd packaging/pypi

# Build
python -m build

# Upload (uses ~/.pypirc or TWINE env vars)
twine upload dist/*

# Verify
<<<<<<< HEAD
pip install elizaos-app
elizaos-app --version
=======
pip install milady
milady --version
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

### 1.4 Reserve the Package Name

<<<<<<< HEAD
If you want to claim the package name immediately before the full release:
=======
If you want to claim the `milady` name immediately before the full release:
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

```bash
cd packaging/pypi
python -m build
twine upload dist/*
```

The alpha version (`2.0.0a7`) is fine for name reservation.

---

## 2. Homebrew

### 2.1 Create the Tap Repository (one-time)

A Homebrew "tap" is just a GitHub repo with a naming convention.

<<<<<<< HEAD
1. **Create a GitHub repo** named `homebrew-tap` under the `elizaos` org:
   - URL will be: `https://github.com/elizaos/homebrew-tap`
=======
1. **Create a GitHub repo** named `homebrew-tap` under the `milady-ai` org:
   - URL will be: `https://github.com/milady-ai/homebrew-tap`
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

2. **Initialize the repo**:

```bash
# Clone and set up
<<<<<<< HEAD
git clone https://github.com/elizaos/homebrew-tap.git
=======
git clone https://github.com/milady-ai/homebrew-tap.git
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
cd homebrew-tap

# Copy the formula
mkdir -p Formula
<<<<<<< HEAD
cp /path/to/elizaos-app/packaging/homebrew/elizaos-app.rb Formula/elizaos-app.rb
=======
cp /path/to/milady/packaging/homebrew/milady.rb Formula/milady.rb
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

3. **Get the SHA256 hash** of the npm tarball:

```bash
# Download the tarball and compute hash
<<<<<<< HEAD
curl -fsSL "https://registry.npmjs.org/elizaos/-/elizaos-2.0.0-alpha.7.tgz" -o elizaos-app.tgz
shasum -a 256 elizaos-app.tgz
# Replace PLACEHOLDER_SHA256 in elizaos-app.rb with the actual hash
=======
curl -fsSL "https://registry.npmjs.org/miladyai/-/miladyai-2.0.0-alpha.7.tgz" -o milady.tgz
shasum -a 256 milady.tgz
# Replace PLACEHOLDER_SHA256 in milady.rb with the actual hash
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

4. **Push the formula**:

```bash
<<<<<<< HEAD
git add Formula/elizaos-app.rb
git commit -m "Add elizaos-app formula"
=======
git add Formula/milady.rb
git commit -m "Add milady formula"
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
git push origin main
```

### 2.2 Test the Formula

```bash
# Test locally before pushing
<<<<<<< HEAD
brew install --build-from-source Formula/elizaos-app.rb

# Or after pushing to the tap repo
brew tap elizaos/tap
brew install elizaos-app
=======
brew install --build-from-source Formula/milady.rb

# Or after pushing to the tap repo
brew tap milady-ai/tap
brew install milady
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

### 2.3 Users Install With

```bash
<<<<<<< HEAD
brew tap elizaos/tap
brew install elizaos-app
=======
brew tap milady-ai/tap
brew install milady
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

Or one-liner:

```bash
<<<<<<< HEAD
brew install elizaos/tap/elizaos-app
=======
brew install milady-ai/tap/milady
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

### 2.4 Updating for New Releases

```bash
# Compute new SHA256
<<<<<<< HEAD
curl -fsSL "https://registry.npmjs.org/elizaos/-/elizaos-NEW_VERSION.tgz" -o elizaos-app.tgz
shasum -a 256 elizaos-app.tgz
=======
curl -fsSL "https://registry.npmjs.org/miladyai/-/miladyai-NEW_VERSION.tgz" -o milady.tgz
shasum -a 256 milady.tgz
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

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
<<<<<<< HEAD
   - Name: `elizaos-app`
   - Display name: "elizaOS App — Personal AI Assistant"
=======
   - Name: `milady`
   - Display name: "Milady — Personal AI Assistant"
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

4. **Build and upload the source package**:

```bash
<<<<<<< HEAD
cd /path/to/elizaos-app
=======
cd /path/to/milady
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

# Copy debian/ packaging into place
cp -r packaging/debian .

# Build the source package
dpkg-buildpackage -S -sa -k"YOUR_GPG_KEY_ID"

# Upload to PPA
<<<<<<< HEAD
dput ppa:YOUR_USERNAME/elizaos-app ../elizaos-app_2.0.0~alpha7-1_source.changes
=======
dput ppa:YOUR_USERNAME/milady ../milady_2.0.0~alpha7-1_source.changes
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

5. **Users install with**:

```bash
<<<<<<< HEAD
sudo add-apt-repository ppa:YOUR_USERNAME/elizaos-app
sudo apt update
sudo apt install elizaos-app
=======
sudo add-apt-repository ppa:YOUR_USERNAME/milady
sudo apt update
sudo apt install milady
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

### 3.2 Option B: Self-Hosted apt Repository

This gives you more control and works across all Debian-based distros.

1. **Build the .deb package**:

```bash
<<<<<<< HEAD
cd /path/to/elizaos-app
=======
cd /path/to/milady
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
cp -r packaging/debian .

# Install build dependencies
sudo apt install debhelper nodejs npm

# Build the package
dpkg-buildpackage -us -uc -b

# The .deb will be in the parent directory
<<<<<<< HEAD
ls ../elizaos-app_*.deb
=======
ls ../milady_*.deb
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

2. **Set up a repo using GitHub Pages or a server**:

```bash
# Create repo structure
<<<<<<< HEAD
mkdir -p apt-repo/pool/main/m/elizaos-app
mkdir -p apt-repo/dists/stable/main/binary-amd64

# Copy the .deb
cp ../elizaos-app_*.deb apt-repo/pool/main/m/elizaos-app/
=======
mkdir -p apt-repo/pool/main/m/milady
mkdir -p apt-repo/dists/stable/main/binary-amd64

# Copy the .deb
cp ../milady_*.deb apt-repo/pool/main/m/milady/
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

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
<<<<<<< HEAD
curl -fsSL https://apt.elizaos-app.ai/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/elizaos-app.gpg

# Add the repo
echo "deb [signed-by=/usr/share/keyrings/elizaos-app.gpg] https://apt.elizaos-app.ai stable main" | \
  sudo tee /etc/apt/sources.list.d/elizaos-app.list

sudo apt update
sudo apt install elizaos-app
=======
curl -fsSL https://apt.milady.ai/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/milady.gpg

# Add the repo
echo "deb [signed-by=/usr/share/keyrings/milady.gpg] https://apt.milady.ai stable main" | \
  sudo tee /etc/apt/sources.list.d/milady.list

sudo apt update
sudo apt install milady
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
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
<<<<<<< HEAD
snapcraft register elizaos-app
=======
snapcraft register milady
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

### 4.2 Build the Snap

```bash
<<<<<<< HEAD
cd /path/to/elizaos-app
=======
cd /path/to/milady
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

# Copy snapcraft.yaml into place
mkdir -p snap
cp packaging/snap/snapcraft.yaml snap/

# Build the snap (requires LXD or Multipass)
snapcraft

<<<<<<< HEAD
# This produces: elizaos-app_2.0.0-alpha.7_amd64.snap
=======
# This produces: milady_2.0.0-alpha.7_amd64.snap
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

### 4.3 Test Locally

```bash
# Install the local snap
<<<<<<< HEAD
sudo snap install elizaos-app_*.snap --classic --dangerous

# Test
elizaos-app --version
elizaos-app --help
=======
sudo snap install milady_*.snap --classic --dangerous

# Test
milady --version
milady --help
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

### 4.4 Publish to Snap Store

```bash
# Upload to edge channel first
<<<<<<< HEAD
snapcraft upload elizaos-app_*.snap --release=edge

# After testing, promote to stable
snapcraft release elizaos-app <revision> stable
=======
snapcraft upload milady_*.snap --release=edge

# After testing, promote to stable
snapcraft release milady <revision> stable
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

### 4.5 Users Install With

```bash
<<<<<<< HEAD
sudo snap install elizaos-app --classic
=======
sudo snap install milady --classic
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
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
<<<<<<< HEAD
flatpak-builder --repo=repo build-dir ai.elizaos-app.elizaOS App.yml

# Create a bundle for testing
flatpak build-bundle repo elizaos-app.flatpak ai.elizaos-app.elizaOS App
=======
flatpak-builder --repo=repo build-dir ai.milady.Milady.yml

# Create a bundle for testing
flatpak build-bundle repo milady.flatpak ai.milady.Milady
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

### 5.4 Test Locally

```bash
# Install from local bundle
<<<<<<< HEAD
flatpak --user install elizaos-app.flatpak

# Run
flatpak run ai.elizaos-app.elizaOS App --version
flatpak run ai.elizaos-app.elizaOS App start
=======
flatpak --user install milady.flatpak

# Run
flatpak run ai.milady.Milady --version
flatpak run ai.milady.Milady start
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

### 5.5 Publish to Flathub

1. Fork https://github.com/flathub/flathub
<<<<<<< HEAD
2. Create a new repo: `github.com/flathub/ai.elizaos-app.elizaOS App`
=======
2. Create a new repo: `github.com/flathub/ai.milady.Milady`
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
3. Add the manifest and supporting files
4. Submit a PR — Flathub maintainers will review

### 5.6 Users Install With

```bash
<<<<<<< HEAD
flatpak install flathub ai.elizaos-app.elizaOS App
flatpak run ai.elizaos-app.elizaOS App start
=======
flatpak install flathub ai.milady.Milady
flatpak run ai.milady.Milady start
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

---


## 6. Google Play Store (Android)

### 6.1 Account Setup (one-time)

1. **Create a Google Play Developer account** at https://play.google.com/console/signup
   - One-time $25 registration fee
   - Requires identity verification

2. **Create the app listing**:
   - Go to Google Play Console → "Create app"
<<<<<<< HEAD
   - App name: "elizaOS App"
=======
   - App name: "Milady"
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
   - Default language: English (United States)
   - App type: App
   - Free / Paid: Free

3. **Set up Google Play App Signing**:
   - Go to Release → Setup → App signing
   - Choose "Let Google manage and protect your app signing key" (recommended)
   - Generate an **upload keystore** for CI:

```bash
<<<<<<< HEAD
keytool -genkeypair   -alias elizaos-app-upload   -keyalg RSA -keysize 2048   -validity 10000   -keystore elizaos-app-upload.jks   -storepass YOUR_STORE_PASSWORD   -dname "CN=elizaOS App AI, O=elizaos, L=Internet, C=US"
=======
keytool -genkeypair   -alias milady-upload   -keyalg RSA -keysize 2048   -validity 10000   -keystore milady-upload.jks   -storepass YOUR_STORE_PASSWORD   -dname "CN=Milady AI, O=milady-ai, L=Internet, C=US"
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
```

4. **Upload the upload key certificate** to Play Console:

```bash
<<<<<<< HEAD
keytool -export -alias elizaos-app-upload   -keystore elizaos-app-upload.jks   -rfc > elizaos-app-upload-cert.pem
```

Upload `elizaos-app-upload-cert.pem` in Play Console → App signing.
=======
keytool -export -alias milady-upload   -keystore milady-upload.jks   -rfc > milady-upload-cert.pem
```

Upload `milady-upload-cert.pem` in Play Console → App signing.
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

5. **Create a service account for CI**:
   - Go to Play Console → Setup → API access
   - Link to Google Cloud project
   - Create a service account with "Release manager" role
   - Download the JSON key file

### 6.2 Required GitHub Secrets

| Secret | Description |
|---|---|
<<<<<<< HEAD
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 elizaos-app-upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | `elizaos-app-upload` |
=======
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 milady-upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | `milady-upload` |
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
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
<<<<<<< HEAD
ELIZA_KEYSTORE_PATH=/path/to/elizaos-app-upload.jks ELIZA_KEYSTORE_PASSWORD=yourpass ELIZA_KEY_ALIAS=elizaos-app-upload ELIZA_KEY_PASSWORD=yourpass ./gradlew bundleRelease
=======
MILADY_KEYSTORE_PATH=/path/to/milady-upload.jks MILADY_KEYSTORE_PASSWORD=yourpass MILADY_KEY_ALIAS=milady-upload MILADY_KEY_PASSWORD=yourpass ./gradlew bundleRelease
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

# AAB is at app/build/outputs/bundle/release/app-release.aab
```

### 6.4 Publish via Fastlane

```bash
cd apps/app/android

# Install Fastlane
bundle install

# Upload to internal testing
<<<<<<< HEAD
PLAY_STORE_JSON_KEY=/path/to/play-store-key.json ELIZA_KEYSTORE_PATH=/path/to/elizaos-app-upload.jks ELIZA_KEYSTORE_PASSWORD=yourpass ELIZA_KEY_ALIAS=elizaos-app-upload ELIZA_KEY_PASSWORD=yourpass bundle exec fastlane internal
=======
PLAY_STORE_JSON_KEY=/path/to/play-store-key.json MILADY_KEYSTORE_PATH=/path/to/milady-upload.jks MILADY_KEYSTORE_PASSWORD=yourpass MILADY_KEY_ALIAS=milady-upload MILADY_KEY_PASSWORD=yourpass bundle exec fastlane internal
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

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
gh workflow run release-orchestrator.yml -f version=2.0.0-alpha.87
```

### Required GitHub Secrets

| Secret | Where to get it | Used by |
|---|---|---|
<<<<<<< HEAD
| `SNAP_STORE_CREDENTIALS` | `snapcraft export-login --snaps=elizaos-app --acls=package_push -` | Snap publishing |
| `HOMEBREW_TAP_TOKEN` | GitHub PAT with `repo` scope for `elizaos/homebrew-tap` | Homebrew formula updates |
| `PYPI_API_TOKEN` | https://pypi.org/manage/account/token/ (or use trusted publishing) | PyPI uploads |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 elizaos-app-upload.jks` | Android AAB signing |
=======
| `SNAP_STORE_CREDENTIALS` | `snapcraft export-login --snaps=milady --acls=package_push -` | Snap publishing |
| `HOMEBREW_TAP_TOKEN` | GitHub PAT with `repo` scope for `milady-ai/homebrew-tap` | Homebrew formula updates |
| `PYPI_API_TOKEN` | https://pypi.org/manage/account/token/ (or use trusted publishing) | PyPI uploads |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 milady-upload.jks` | Android AAB signing |
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
| `ANDROID_KEYSTORE_PASSWORD` | Android upload keystore password | Android AAB signing |
| `ANDROID_KEY_ALIAS` | Android upload key alias | Android AAB signing |
| `ANDROID_KEY_PASSWORD` | Android upload key password | Android AAB signing |
| `PLAY_STORE_SERVICE_ACCOUNT_JSON` | Google Cloud Console service account JSON (base64) | Play Store uploads |
| `APPLE_ID` | Apple ID email | Apple store publishing |
| `APPLE_TEAM_ID` | 10-char Apple team ID | Apple store publishing |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com | Apple store publishing |

### PyPI Trusted Publishing (recommended)

Instead of API tokens, use OIDC trusted publishing:
<<<<<<< HEAD
1. Go to https://pypi.org/manage/project/elizaos-app/settings/publishing/
2. Add a "GitHub Actions" publisher:
   - Owner: `elizaos`
   - Repository: `elizaos-app`
=======
1. Go to https://pypi.org/manage/project/milady/settings/publishing/
2. Add a "GitHub Actions" publisher:
   - Owner: `milady-ai`
   - Repository: `milady`
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
   - Workflow: `publish-packages.yml`
   - Environment: (leave blank or set one)

This eliminates the need for `PYPI_API_TOKEN` — GitHub Actions authenticates directly.

---

## 8. iOS App Store

### 8.1 Apple Developer Program (one-time)

1. **Enroll** at https://developer.apple.com/programs/ ($99/year)
<<<<<<< HEAD
2. **Create App ID**: Bundle ID `ai.elizaos-app.app`, enable Push Notifications
3. **Create private certificates repo** `elizaos/certificates` for Fastlane Match
4. **Create App Store Connect app**: Platform iOS, Bundle ID `ai.elizaos-app.app`
=======
2. **Create App ID**: Bundle ID `ai.milady.app`, enable Push Notifications
3. **Create private certificates repo** `milady-ai/certificates` for Fastlane Match
4. **Create App Store Connect app**: Platform iOS, Bundle ID `ai.milady.app`
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e

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
| `packaging/pypi/pyproject.toml` | `version` (use PEP 440: `2.0.0a7` not `2.0.0-alpha.7`) |
<<<<<<< HEAD
| `packaging/pypi/elizaos-app/__init__.py` | `__version__` |
| `packaging/snap/snapcraft.yaml` | `version` |
| `packaging/debian/changelog` | Add new entry at top |
| `packaging/homebrew/elizaos-app.rb` | `url` + `sha256` (after npm publish) |
| `packaging/flatpak/ai.elizaos-app.elizaOS App.metainfo.xml` | Add new `<release>` entry |
=======
| `packaging/pypi/milady/__init__.py` | `__version__` |
| `packaging/snap/snapcraft.yaml` | `version` |
| `packaging/debian/changelog` | Add new entry at top |
| `packaging/homebrew/milady.rb` | `url` + `sha256` (after npm publish) |
| `packaging/flatpak/ai.milady.Milady.metainfo.xml` | Add new `<release>` entry |
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
| `apps/app/android/app/build.gradle` | `versionCode` + `versionName` (via env vars in CI) |

### Version Format Mapping

| Platform | Format | Example |
|---|---|---|
| npm | semver pre-release | `2.0.0-alpha.7` |
| PyPI (PEP 440) | alpha suffix | `2.0.0a7` |
| Debian | tilde for pre-release | `2.0.0~alpha7-1` |
| Snap | semver-ish | `2.0.0-alpha.7` |
| Flatpak | semver | `2.0.0-alpha.7` |
| Homebrew | follows npm tarball URL | (automatic) |

---

## Quick Reference: User Install Commands

| Platform | Command |
|---|---|
<<<<<<< HEAD
| **npm** | `npm install -g elizaos` |
| **PyPI** | `pip install elizaos-app` |
| **Homebrew** | `brew install elizaos/tap/elizaos-app` |
| **apt** | `sudo apt install elizaos-app` (after adding repo) |
| **Snap** | `sudo snap install elizaos-app --classic` |
| **Flatpak** | `flatpak install flathub ai.elizaos-app.elizaOS App` |
| **Google Play** | Search "elizaOS App" on Play Store |
| **iOS App Store** | Search "elizaOS App" on App Store |
| **Mac App Store** | Search "elizaOS App" on Mac App Store |
| **npx** | `npx elizaos` (no install) |
| **pipx** | `pipx install elizaos-app` |
=======
| **npm** | `npm install -g miladyai` |
| **PyPI** | `pip install milady` |
| **Homebrew** | `brew install milady-ai/tap/milady` |
| **apt** | `sudo apt install milady` (after adding repo) |
| **Snap** | `sudo snap install milady --classic` |
| **Flatpak** | `flatpak install flathub ai.milady.Milady` |
| **Google Play** | Search "Milady" on Play Store |
| **iOS App Store** | Search "Milady" on App Store |
| **Mac App Store** | Search "Milady" on Mac App Store |
| **npx** | `npx miladyai` (no install) |
| **pipx** | `pipx install milady` |
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
