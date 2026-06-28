# Maintainer: Windows Store + signing credentials

Playbook for the secrets `windows-store-release.yml` consumes. Same shape as
the apt-repo playbook ([admin-apt-repo-setup.md](./admin-apt-repo-setup.md)):
generate → set the repo secret → sanity-run → rotate/revoke.

The workflow has two credential groups:

1. **Authenticode signing** — signs the MSIX. Optional: when absent the MSIX is
   built **unsigned** (with a warning). This is the *same* cert as the desktop
   Authenticode signing used by `release-electrobun.yml`.
2. **Partner Center submission** — submits the MSIX to the Microsoft Store via
   the Azure AD service-principal flow. Optional: gates the `submit-to-store`
   job (build still runs and attaches the MSIX to the GitHub Release).

## Prerequisite — register the app in Partner Center (one-time)

Submission needs a registered Store app:

1. `https://partner.microsoft.com` → Windows & Xbox → Overview → New product →
   App; reserve the name "elizaOS".
2. Complete the store listing (description, screenshots, age ratings, privacy
   policy URL).
3. Note the **Store ID** (format `9XXXXXXXXXXXXXXX`) → `MS_APP_ID`.

## Secrets this workflow reads

| Secret | Required? | Used as |
| --- | --- | --- |
| `WINDOWS_SIGN_CERT_BASE64` | Optional (else unsigned MSIX) | decoded to `signing.pfx`, passed as `WINDOWS_SIGN_CERT_BASE64` to `build-msix.ps1` |
| `WINDOWS_SIGN_CERT_PASSWORD` | with the cert | `.pfx` password |
| `MS_TENANT_ID` | Optional (gates `submit-to-store`) | Azure AD tenant for the OAuth token |
| `MS_CLIENT_ID` | with submission | service-principal client id |
| `MS_CLIENT_SECRET` | with submission | service-principal client secret |
| `MS_APP_ID` | with submission | Partner Center Store app id |

The "Check signing credentials" step warns + builds unsigned when
`WINDOWS_SIGN_CERT_BASE64` is empty; the "Check Partner Center credentials"
step keys off `MS_TENANT_ID` and sets `can_submit=false` (skips the submit job)
when empty.

## Step 1 — Authenticode signing cert (re-enter from source)

The signing cert is the same Authenticode code-signing certificate the desktop
release uses. Export the issued cert (and its private key) as a password-
protected `.pfx`, then base64 it:

```sh
base64 -w0 elizaos-codesign.pfx > elizaos-codesign.pfx.b64   # Linux
# macOS: base64 -i elizaos-codesign.pfx -o elizaos-codesign.pfx.b64
```

- `WINDOWS_SIGN_CERT_BASE64` = contents of `elizaos-codesign.pfx.b64`
- `WINDOWS_SIGN_CERT_PASSWORD` = the `.pfx` export password

> `build-msix.ps1` also reads `WINDOWS_SIGN_TIMESTAMP_URL` (RFC 3161 timestamp
> server) and defaults it to `http://timestamp.digicert.com` when unset. The
> store workflow does not set it; the desktop workflow `release-electrobun.yml`
> does. Configure `WINDOWS_SIGN_TIMESTAMP_URL` as a repo secret only if you need
> a non-default timestamp authority for the desktop path.

## Step 2 — Azure AD service principal (Partner Center submission)

The submit job authenticates to the Partner Center API with a client-credentials
grant, then links the app via `MS_APP_ID`.

1. **Create the Azure AD app (re-enter ids / generate the secret):**
   - `https://portal.azure.com` → Azure Active Directory → App registrations →
     New registration. Name `elizaos-store-ci`, single tenant.
   - **Application (client) ID** → `MS_CLIENT_ID`
   - **Directory (tenant) ID** → `MS_TENANT_ID`
   - Certificates & secrets → New client secret → copy the value →
     `MS_CLIENT_SECRET` (**generate fresh**; visible once)
2. **Link the Azure AD app to Partner Center:**
   - Partner Center → Account settings → User management → Azure AD applications
     → Add Azure AD application → select your app → assign role **Manager**
     (needs submission create/commit permission).
3. `MS_APP_ID` = the Store ID from the prerequisite.

## Step 3 — Set the GitHub secrets

Add the six secrets at
`https://github.com/elizaOS/eliza/settings/secrets/actions`, then shred local
cert files:

```sh
shred -u elizaos-codesign.pfx elizaos-codesign.pfx.b64
```

## Step 4 — Sanity-trigger the workflow

Build-only first (no Store submission):

```sh
gh workflow run windows-store-release.yml \
  --repo elizaOS/eliza \
  --field version=2.0.0-beta.0 \
  --field tag=v2.0.0-beta.0 \
  --field submit_to_store=false
gh run watch --repo elizaOS/eliza
```

A green build-only run downloads the Windows installer from the `v…` release,
builds the MSIX (signed if the cert is set), and attaches it to the GitHub
Release. Once that's confirmed, repeat with `submit_to_store=true` to exercise
the Partner Center path.

Misconfiguration symptoms:

- `Write-Warning "WINDOWS_SIGN_CERT_BASE64 not set — MSIX will be built
  unsigned"` → signing cert secret empty.
- `Write-Warning "MS_TENANT_ID not set — … not submitted"` → Partner Center
  secrets empty; the `submit-to-store` job is skipped.
- A `401`/`403` from the token or `/applications/<id>` call → wrong
  tenant/client/secret, or the Azure AD app isn't linked to Partner Center as
  **Manager**, or `MS_APP_ID` is wrong.

## Rotating credentials

- **Client secret:** add a new client secret in Azure AD, update
  `MS_CLIENT_SECRET`, verify a run, then delete the old secret. (Tenant/client
  ids and `MS_APP_ID` don't change.)
- **Signing cert:** when the cert nears expiry, issue a replacement, re-export
  the `.pfx`, update `WINDOWS_SIGN_CERT_BASE64` + `WINDOWS_SIGN_CERT_PASSWORD`.

## Revoking a compromised credential

- **Client secret leaked:** delete it in Azure AD → App registrations →
  Certificates & secrets (it stops working immediately); issue a new one and
  update the secret. If the whole app registration is suspect, delete it and
  re-create + re-link to Partner Center.
- **Signing cert leaked:** revoke the certificate with the issuing CA and
  reissue; update the two signing secrets.

## Related

- [release-secrets-checklist.md](./release-secrets-checklist.md) — every secret,
  every channel.
- `windows-store-release.yml` — the workflow this configures.
- `release-electrobun.yml` — the desktop Authenticode path that shares
  `WINDOWS_SIGN_CERT_BASE64` / `WINDOWS_SIGN_CERT_PASSWORD` /
  `WINDOWS_SIGN_TIMESTAMP_URL`.
