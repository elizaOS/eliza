# Universal / App Links for `eliza.app`

These files let an `https://eliza.app/<path>` link open the **installed native app**
(iOS Universal Links + Android App Links) instead of only the website, paired with
the in-app router in `packages/app/src/deep-link-handler.ts` (`isTrustedAppLink` +
the `https://eliza.app/...` path → hash-route mapping) and the `main.tsx`
`handleDeepLink` that consumes them.

- **`apple-app-site-association`** — served at
  `https://eliza.app/.well-known/apple-app-site-association` (no extension,
  `Content-Type: application/json`). Lists the app bundle + the paths it claims.
- **`assetlinks.json`** — served at `https://eliza.app/.well-known/assetlinks.json`.
  Android App Links statement for `ai.elizaos.app`.

## Deferred — requires the release signing identity (release/ops owner)

The structure here is complete; two values are signing-identity-specific and must
be filled by whoever holds the release certs (they are **not** in the repo):

1. **`apple-app-site-association` → `appIDs`**: replace `TEAMID` with the Apple
   Developer **Team ID** (`<TeamID>.ai.elizaos.app`).
2. **`assetlinks.json` → `sha256_cert_fingerprints`**: replace the `TODO:` with the
   **release** keystore SHA-256 fingerprint
   (`keytool -list -v -keystore <release.keystore>`).

The matching native config also needs to be added in the app shells (the entitlement
+ intent-filter that tell the OS to consult these files):

- **iOS**: `com.apple.developer.associated-domains` entitlement with
  `applinks:eliza.app` (Capacitor iOS project entitlements).
- **Android**: an `autoVerify="true"` intent-filter for `https://eliza.app` in the
  app's `AndroidManifest.xml`.

Until those land + the DNS for `eliza.app` is cut over (tracked separately), the
app handles the custom `elizaos://` scheme as before; the `https` path is wired and
unit-tested (`deep-link-handler.test.ts`) so it works the moment the OS hands the
link over.
