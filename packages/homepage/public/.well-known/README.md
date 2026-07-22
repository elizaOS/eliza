# Universal / App Links for `eliza.app`

The production edge manifest and the Android association file let an
`https://eliza.app/<path>` link open the **installed native app** (iOS Universal
Links + Android App Links) instead of only the website. They pair with the
in-app router in `packages/app/src/deep-link-handler.ts` (`isTrustedAppLink` +
the `https://eliza.app/...` path → hash-route mapping) and the `main.tsx`
`handleDeepLink` that consumes them. This public directory contains Android's
document and the deliberately inert iOS fallback, not the iOS production trust
document.

- **`apple-app-site-association`** — an intentionally inert GitHub Pages
  fallback with a placeholder Team ID. It must not contain a production signing
  identity because the Pages build also publishes from `develop`.
- **`assetlinks.json`** — served at `https://eliza.app/.well-known/assetlinks.json`.
  Android App Links statement for `ai.elizaos.app`.

## iOS release identity and callback

The reviewed production document is
`packages/homepage/edge/apple-app-site-association.json`, outside the Pages
public tree. It uses the Xcode App target's Release Team ID and bundle ID
(`25877RY2EH.ai.elizaos.app`), preserves the normalized legacy routes, and adds
`/auth/callback` for the mobile Authorization Code + PKCE return path. The
paired App target carries both `applinks:eliza.app` and
`webcredentials:eliza.app`: Apple requires the latter association for
`ASWebAuthenticationSession.Callback.https`, independently of password
AutoFill. Both AASA services bind only the reviewed release application ID.

GitHub Pages does not control response headers, so
`.github/workflows/deploy-aasa.yml` publishes an exact-path Cloudflare Worker.
That Worker imports the edge-only manifest, serves it as `application/json`
with `no-store` and `nosniff`, and forwards every other request to the existing
Pages origin. The protected workflow verifies the origin immediately and rolls
back the Worker—or removes a first broken Worker to restore this inert
fallback—before a separate job waits for Apple's asynchronous CDN cache. A CDN
delay never rolls back a healthy origin. Do not use cache busters or Apple's
direct-fetch override as release evidence.

A one-shot read-only operator check is:

```bash
node packages/homepage/scripts/verify-aasa-response.mjs --origin-live --attempts=1
node packages/homepage/scripts/verify-aasa-response.mjs --apple-cdn-live --attempts=1
```

## Android release identity remains deferred

`assetlinks.json` still requires the authoritative Google Play app-signing
certificate fingerprint for `ai.elizaos.app`; an upload certificate must not be
published as though it were the Play identity. This iOS association release does
not change Android's existing custom-scheme or App Links behavior.
