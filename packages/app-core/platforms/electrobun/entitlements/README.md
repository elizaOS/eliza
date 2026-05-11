# macOS entitlements

Two entitlement files drive the Mac App Store distribution variant:

| File                      | Applied to                                     | Purpose                                               |
|---------------------------|------------------------------------------------|-------------------------------------------------------|
| `mas.entitlements`        | Outer `.app` bundle                            | App Sandbox + JIT + network + data/privacy permissions |
| `mas-child.entitlements`  | Every nested Mach-O, framework, helper bundle  | App Sandbox + `cs.inherit` so children inherit scope  |

The direct (non-store) build variant uses neither — it ships with inline
hardened-runtime entitlements only (no App Sandbox), defined in
[`electrobun.config.ts`](../electrobun.config.ts).

## Signing order

Apple TN2206 mandates inside-out signing: deepest binaries first, then
frameworks (so their resource seals are valid), then the outer `.app`.
`scripts/codesign-mas.mjs` walks the bundle and applies this order
automatically. Anything not in this order fails `codesign --verify --deep
--strict`.

## Required env vars

When building the store variant on macOS without `ELECTROBUN_SKIP_CODESIGN=1`:

- `MILADY_MAS_SIGNING_IDENTITY` — e.g. `"3rd Party Mac Developer Application: Acme (TEAMID)"`. Required.
- `MILADY_MAS_INSTALLER_IDENTITY` — e.g. `"3rd Party Mac Developer Installer: Acme (TEAMID)"`. Optional. If set, `codesign-mas.mjs` runs `productbuild` after verification to produce a `.pkg` suitable for App Store Connect upload.

The signing identities come from Apple Developer Portal → Certificates →
"Mac App Distribution" and "Mac Installer Distribution". They are tied to a
Team ID; that Team ID must match the `Identity` configured in App Store
Connect for the app.

## Local testing without an Apple identity

```
bun run codesign:mas:dry-run -- --app=/path/to/Built.app
```

This prints the codesign command order without executing anything. Useful for
debugging the walk order against a real built bundle.

## Build invocation

The desktop build script invokes the codesign step automatically:

```
MILADY_MAS_SIGNING_IDENTITY="3rd Party Mac Developer Application: ..." \
MILADY_MAS_INSTALLER_IDENTITY="3rd Party Mac Developer Installer: ..." \
bun run build:desktop -- --build-variant=store
```

If `ELECTROBUN_SKIP_CODESIGN=1` is set, the MAS step is skipped and the ad-hoc
Eliza signing is applied instead (useful for local dev builds).
