# Maintainer: Apple release credentials (iOS App Store + Mac App Store)

Playbook for the secrets `apple-store-release.yml` consumes. Same shape as the
apt-repo playbook ([admin-apt-repo-setup.md](./admin-apt-repo-setup.md)):
generate → set the repo secret → sanity-run → rotate/revoke.

The workflow has two independent jobs:

- **`build-ios`** — builds + uploads the iOS IPA to TestFlight / App Store via
  Fastlane, signing with **Fastlane Match** certs.
- **`build-macos`** — builds the Electrobun app, re-signs for the **Mac App
  Store**, packages a `.pkg`, and uploads via `xcrun altool` with an **App Store
  Connect API key**.

You can run them separately with the `platform` dispatch input (`ios`, `macos`,
or `both`).

## Secrets this workflow reads

| Secret | Job | Used as |
| --- | --- | --- |
| `APPLE_ID` | both | Apple account id |
| `APPLE_TEAM_ID` | both | Developer Team ID |
| `ITC_TEAM_ID` | iOS | App Store Connect team id (validated, sign-blocking) |
| `APP_STORE_APP_ID` | iOS | delivery target app id (sign-blocking) |
| `MATCH_PASSWORD` | iOS | decrypts the Match cert repo (sign-blocking) |
| `MATCH_GIT_URL` | iOS | Match cert repo git URL (sign-blocking) |
| `MATCH_GIT_BASIC_AUTHORIZATION` | iOS | Match cert repo basic-auth (sign-blocking) |
| `APPLE_APP_SPECIFIC_PASSWORD` | both | `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD` |
| `MAS_CSC_LINK` | macOS | `CSC_LINK` — Mac App Store app cert `.p12` (base64) |
| `MAS_CSC_KEY_PASSWORD` | macOS | `CSC_KEY_PASSWORD` for the app cert |
| `MAS_INSTALLER_CERT` | macOS | "3rd Party Mac Developer Installer" cert `.p12` (base64) |
| `MAS_INSTALLER_KEY_PASSWORD` | macOS | password for the installer cert |
| `APP_STORE_API_KEY_ID` | macOS | API key id (`altool --apiKey`) |
| `APP_STORE_API_ISSUER_ID` | macOS | API issuer id (`altool --apiIssuer`) |
| `APP_STORE_API_KEY_P8` | macOS | `.p8` private key written to `AuthKey_<id>.p8` |

The iOS job's "Validate iOS secrets" step and the macOS job's "Validate signing
secrets" step both exit with `::error::Missing required … secrets: …` listing
the empty ones, so a half-configured job fails loudly rather than producing an
unsigned artifact.

## Where each value comes from

Apple identifiers and issued certificates are **re-entered from source** (Apple
Developer / App Store Connect). Two values you **generate fresh**: the app-
specific password and the App Store Connect API key.

### Account identifiers

- `APPLE_ID` — the Apple Developer account email used for delivery.
- `APPLE_TEAM_ID` — Apple Developer → Membership → Team ID (10-char).
- `ITC_TEAM_ID` — App Store Connect team id (often the same; visible in the
  App Store Connect API or Fastlane `spaceship`).
- `APP_STORE_APP_ID` — the app's App Store Connect numeric app id (Apple ID
  shown on the app's App Information page).

### App-specific password (generate fresh)

At `https://appleid.apple.com` → Sign-In and Security → App-Specific Passwords →
generate one labelled e.g. `elizaos-ci`. The value → `APPLE_APP_SPECIFIC_PASSWORD`.
The workflow exposes it as `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD`.

### iOS signing via Fastlane Match

iOS certs/profiles live in a private **Match** git repo, not in these secrets —
the secrets are how CI *reaches* that repo:

- `MATCH_GIT_URL` — the Match repo URL (e.g.
  `https://github.com/elizaOS/ios-certificates.git`).
- `MATCH_PASSWORD` — the passphrase Match used to encrypt that repo (chosen when
  the repo was first set up with `fastlane match`).
- `MATCH_GIT_BASIC_AUTHORIZATION` — base64 of `username:personal_access_token`
  granting read access to the Match repo:
  ```sh
  printf 'ci-bot:ghp_xxx' | base64
  ```

If the Match repo does not exist yet, create the certs first from a Mac with the
Apple account:

```sh
cd packages/app/ios
bundle exec fastlane match appstore   # creates + pushes encrypted certs
```

### Mac App Store certificates (re-enter from source)

From the Apple Developer certificates portal, issue and export two certs as
`.p12`, then base64 them:

1. **Apple Distribution** (or "3rd Party Mac Developer Application") →
   `MAS_CSC_LINK`, export password → `MAS_CSC_KEY_PASSWORD`.
2. **3rd Party Mac Developer Installer** → `MAS_INSTALLER_CERT`, export password
   → `MAS_INSTALLER_KEY_PASSWORD`.

```sh
base64 -i mas-app.p12 | tr -d '\n'        # → MAS_CSC_LINK
base64 -i mas-installer.p12 | tr -d '\n'  # → MAS_INSTALLER_CERT
```

The workflow imports both into a throwaway keychain and finds the
`Apple Distribution` + `3rd Party Mac Developer Installer` identities by name.

### App Store Connect API key (generate fresh)

At App Store Connect → Users and Access → **Integrations → App Store Connect
API → Generate API Key** (role: at least App Manager). On generation:

- the **Key ID** → `APP_STORE_API_KEY_ID`
- the **Issuer ID** (shown above the key list) → `APP_STORE_API_ISSUER_ID`
- the **`AuthKey_<KeyID>.p8`** file (downloads once) → paste its full contents
  into `APP_STORE_API_KEY_P8`

The macOS job writes the `.p8` to
`~/.appstoreconnect/private_keys/AuthKey_<APP_STORE_API_KEY_ID>.p8` and calls
`xcrun altool --upload-app --apiKey <id> --apiIssuer <issuer>`, so the three
values must come from the same generated key.

## Set the GitHub secrets

Add every secret from the table at
`https://github.com/elizaOS/eliza/settings/secrets/actions`, then shred local
`.p12` / `.p8` / base64 files:

```sh
shred -u mas-app.p12 mas-installer.p12 AuthKey_*.p8
```

## Sanity-trigger the workflow

Start with iOS only (TestFlight), then macOS:

```sh
gh workflow run apple-store-release.yml \
  --repo elizaOS/eliza \
  --field platform=ios \
  --field track=testflight \
  --field version=2.0.0-beta.0
gh run watch --repo elizaOS/eliza
```

```sh
gh workflow run apple-store-release.yml \
  --repo elizaOS/eliza \
  --field platform=macos \
  --field version=2.0.0-beta.0
```

Misconfiguration symptoms:

- `::error::Missing required iOS signing secrets: MATCH_GIT_URL …` → a Match or
  delivery secret is empty.
- `::error::Missing required signing secrets: MAS_CSC_LINK …` → a Mac App Store
  cert or API-key secret is empty.

## Rotating credentials

- **App-specific password / API key:** generate a new one, update the
  secret(s), verify a run, then revoke the old one at appleid.apple.com /
  App Store Connect.
- **Match certs:** `fastlane match nuke distribution` then re-create; update
  `MATCH_PASSWORD` only if you change the passphrase.
- **Mac App Store certs:** revoke in the Developer portal, issue replacements,
  re-export `.p12`, update the four `MAS_*` secrets.

## Revoking a compromised credential

- API key — revoke in App Store Connect → Integrations; the `.p8` is dead
  immediately.
- App-specific password — revoke at appleid.apple.com.
- Distribution/installer certs — revoke in the Developer portal (this
  invalidates in-flight signing with that cert), then reissue.

## Related

- [release-secrets-checklist.md](./release-secrets-checklist.md) — every secret,
  every channel.
- `apple-store-release.yml` — the workflow this configures.
