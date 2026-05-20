# Babylon TWA (Trusted Web Activity)

This directory contains the configuration for building a Trusted Web Activity (TWA)
Android APK from the Babylon PWA. This APK is used for distribution on the
**Solana Mobile dApp Store**.

## Prerequisites

- Java 8+ JDK
- Android SDK (or Android Studio)
- `@bubblewrap/cli` installed globally: `npm i -g @bubblewrap/cli`

## Build Steps

### 1. First-time setup

```bash
# Initialize the Bubblewrap project from the live manifest
bubblewrap init --manifest https://babylon.market/manifest.webmanifest

# Or use the local twa-manifest.json
bubblewrap init --manifest ./twa-manifest.json
```

Bubblewrap will prompt for JDK and Android SDK paths. It can download them
automatically if they're not installed.

### 2. Generate a signing key (first time only)

```bash
keytool -genkeypair \
  -alias babylon \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -keystore signing-key.keystore
```

**Important**: Use a **dedicated signing key** separate from any future Google
Play Store key. Store it securely — it cannot be changed after submission.

### 3. Build the signed APK

```bash
bubblewrap build
```

This produces:
- `app-release-signed.apk` — for Solana dApp Store submission
- `app-release-bundle.aab` — for Google Play (if needed later)

### 4. Verify Digital Asset Links

The TWA needs to verify that the Android app owns the web domain. Add the
SHA-256 fingerprint of your signing key to:

```
https://babylon.market/.well-known/assetlinks.json
```

Generate the fingerprint:

```bash
keytool -list -v -keystore signing-key.keystore -alias babylon | grep SHA256
```

Then create `assetlinks.json`:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "market.babylon.app",
    "sha256_cert_fingerprints": ["YOUR_SHA256_FINGERPRINT"]
  }
}]
```

## Solana dApp Store Submission

### Requirements

- Publisher wallet with ~0.2 SOL
- KYC/KYB verification via [Publisher Portal](https://publisher.solanamobile.com)
- App icon: 512x512px ✅ (already generated)
- Banner graphic: 1200x600px (create separately)
- Minimum 4 screenshots at 1080p
- Signed release APK (not debug)

### Steps

1. Sign up at the Solana Mobile Publisher Portal
2. Complete KYC/KYB verification
3. Connect publisher wallet
4. Create publisher NFT
5. Create dApp NFT with metadata
6. Upload the signed APK
7. Submit for review (2-5 business days)

## Solana Mobile Wallet Adapter (MWA)

MWA is registered automatically in the web app via `SolanaMobileProvider.tsx`
when running on Android. Since TWAs use Chrome's rendering engine, MWA
should work seamlessly inside the dApp Store listing.

Supported wallets: Phantom, Solflare, Backpack (on Android)
