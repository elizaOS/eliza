# Windows Code Signing Setup

## Overview

Windows code signing eliminates SmartScreen warnings and is required for Microsoft Store submission. The signing pipeline is integrated into `release-electrobun.yml` and activates when the required secrets are configured.

GitHub releases now publish a standalone **Inno Setup 6.7.1** installer as the primary Windows download. The signed **MSIX** remains available as a secondary Windows artifact for Store-oriented distribution.

## Certificate Options

### Option A: Standard/EV Code Signing Certificate

Purchase from a CA (DigiCert, Sectigo, GlobalSign, etc.):
- **Standard OV** (~$200-400/yr) — SmartScreen reputation builds gradually
- **EV** (~$300-500/yr) — Immediate SmartScreen trust

As of June 2023, both types require hardware key storage (HSM/USB token).

**For CI use**, you'll need cloud-based signing:
- **DigiCert KeyLocker** — Cloud HSM, works with signtool
- **SSL.com eSigner** — Cloud signing service
- **Azure Key Vault** — If you already use Azure

Export the certificate as PFX (if your CA supports it) and base64-encode it:
```bash
base64 -i certificate.pfx | tr -d '\n'
```

### Option B: Azure Trusted Signing

Microsoft's managed service (~$10/month):
1. Create Azure Trusted Signing resource
2. Set up identity validation
3. Create a certificate profile
4. Use `azure/trusted-signing-action@v0.5.0` in CI

This requires different secrets (`AZURE_SIGN_*`) and a different workflow step.

## GitHub Secrets Setup

### For PFX-based signing:

| Secret | Description |
|--------|-------------|
| `WINDOWS_SIGN_CERT_BASE64` | Base64-encoded PFX certificate |
| `WINDOWS_SIGN_CERT_PASSWORD` | PFX password |
| `WINDOWS_SIGN_TIMESTAMP_URL` | Timestamp server URL (optional, defaults to `http://timestamp.digicert.com`) |

Add these at: **Settings > Secrets and variables > Actions > New repository secret**

### For Azure Trusted Signing:

This requires modifying the workflow to use the Azure action instead of signtool. See the Azure Trusted Signing documentation.

## How It Works

1. `release-electrobun.yml` checks for `WINDOWS_SIGN_CERT_BASE64`
2. If present, runs `sign-windows.ps1` which:
   - Decodes the PFX to a temp file
   - Signs packaged app binaries in the Electrobun build output with `signtool` (SHA-256 + timestamp)
   - Verifies each signature
   - Cleans up the temp certificate
3. The Windows release runner installs **Inno Setup 6.7.1** via `winget` and runs `packaging/inno/build-inno.ps1` to produce `Milady-Setup-{channel}.exe`
4. When signing secrets are present, the Inno compiler signs the **final installer** and the **generated uninstaller**
5. If signing secrets are absent, the workflow logs a warning and still builds an unsigned installer
6. After installer creation, `build-msix.ps1` creates and signs the MSIX package

## SmartScreen Notes

- **EV certificates**: Immediate trust, no SmartScreen warnings from day one
- **Standard OV certificates**: SmartScreen reputation builds over time as users download and install
- **Consistent signing**: Always sign with the same certificate to build reputation
- **Timestamp**: Always use a timestamp server so signatures remain valid after certificate expiry

## Certificate Renewal

When your certificate expires:
1. Obtain a renewed certificate from your CA
2. Export as PFX and base64-encode
3. Update `WINDOWS_SIGN_CERT_BASE64` secret in GitHub
4. The next release will use the new certificate automatically

## Testing Locally

```powershell
# Set environment variables
$env:WINDOWS_SIGN_CERT_BASE64 = Get-Content cert-base64.txt -Raw
$env:WINDOWS_SIGN_CERT_PASSWORD = "your-password"

# Run signing
pwsh -File apps/app/electrobun/scripts/sign-windows.ps1 `
  -ArtifactsDir ./artifacts `
  -BuildDir ./build

# Build the standalone Inno Setup installer
pwsh -File packaging/inno/build-inno.ps1 `
  -BuildDir ./apps/app/electrobun/build `
  -OutputDir ./apps/app/electrobun/artifacts `
  -Version "2.0.0-alpha.96" `
  -Channel "canary"

# Verify a signed file
signtool verify /pa /v path/to/signed.exe
```

## CI Compiler Pin

The release workflow installs **Inno Setup 6.7.1** on the Windows runner with:

```powershell
winget install --exact --id JRSoftware.InnoSetup --version 6.7.1 --accept-package-agreements --accept-source-agreements --disable-interactivity
```
