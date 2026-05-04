# MSIX Packaging for Microsoft Store

## Overview

This directory contains everything needed to build MSIX packages for Microsoft Store distribution.

## Files

| File | Purpose |
|------|---------|
| `AppxManifest.xml` | MSIX package manifest (app identity, capabilities) |
| `build-msix.ps1` | Build script — creates and signs MSIX package |
| `generate-placeholder-assets.ps1` | Creates placeholder visual assets |
| `assets/` | Store visual assets (tile logos) |
| `store/` | Store listing metadata and screenshots |

## Prerequisites

1. **Code signing certificate** — see [docs/windows-signing.md](../../docs/windows-signing.md)
2. **Windows SDK** — installed on CI runner (available on `windows-latest`)
3. **Microsoft Partner Center account** — for Store submission ($19 one-time)

## Building Locally

```powershell
# 1. Sign the executables first
pwsh -File apps/app/electrobun/scripts/sign-windows.ps1 `
  -ArtifactsDir ./apps/app/electrobun/artifacts `
  -BuildDir ./apps/app/electrobun/build

# 2. Build MSIX
pwsh -File packaging/msix/build-msix.ps1 `
  -BuildDir ./apps/app/electrobun/build `
  -OutputDir ./apps/app/electrobun/artifacts `
  -Version "2.0.0-alpha.84"
```

## CI Pipeline

Both steps run automatically in `release-electrobun.yml` when `WINDOWS_SIGN_CERT_BASE64` is configured. If the secret is absent, signing and MSIX generation are skipped gracefully.

## Store Submission

1. Create a Microsoft Partner Center account at https://partner.microsoft.com
2. Register the app identity ("ElizaOS.App")
3. Update `AppxManifest.xml` Publisher field with your actual publisher ID
4. Replace placeholder assets in `assets/` with final artwork
5. Add screenshots to `store/screenshots/`
6. Upload the signed MSIX via Partner Center
7. Submit for certification review

## Updating the Publisher Identity

After registering in Partner Center, you'll receive a Publisher ID like:
`CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`

Update it in:
- `AppxManifest.xml` > `Identity Publisher="..."`
- `store/listing.json` > `identity.publisher`
