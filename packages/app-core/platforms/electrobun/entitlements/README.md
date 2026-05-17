# macOS entitlements

Two entitlement files drive the Mac App Store distribution variant:

| File                      | Applied to                                     | Purpose                                               |
|---------------------------|------------------------------------------------|-------------------------------------------------------|
| `mas.entitlements`        | Outer `.app` bundle                            | App Sandbox + network + data/privacy permissions |
| `mas-child.entitlements`  | Every nested Mach-O, framework, helper bundle  | App Sandbox + `cs.inherit` so children inherit scope  |
| `mas-bun.entitlements`    | `Contents/MacOS/bun` only                      | App Sandbox + `cs.inherit` + Bun-scoped `allow-jit` |

The direct (non-store) build variant uses neither — it ships with inline
hardened-runtime entitlements only (no App Sandbox), defined in
[`electrobun.config.ts`](../electrobun.config.ts).

The Store variant intentionally does not request
`com.apple.security.cs.allow-unsigned-executable-memory` or
`com.apple.security.cs.disable-library-validation`. Bun's macOS runtime is the
only known MAS JIT consumer, so `allow-jit` is scoped to `mas-bun.entitlements`
instead of the outer app.

## Signing order

Apple TN2206 mandates inside-out signing: deepest binaries first, then
frameworks (so their resource seals are valid), then the outer `.app`.
`scripts/codesign-mas.mjs` walks the bundle and applies this order
automatically. Anything not in this order fails `codesign --verify --deep
--strict`.

## Required env vars

When building the store variant on macOS without `ELECTROBUN_SKIP_CODESIGN=1`:

- `ELIZA_MAS_SIGNING_IDENTITY` — e.g. `"3rd Party Mac Developer Application: Acme (TEAMID)"`. Required.
- `ELIZA_MAS_INSTALLER_IDENTITY` — e.g. `"3rd Party Mac Developer Installer: Acme (TEAMID)"`. Optional. If set, `codesign-mas.mjs` runs `productbuild` after verification to produce a `.pkg` suitable for App Store Connect upload.

The signing identities come from Apple Developer Portal → Certificates →
"Mac App Distribution" and "Mac Installer Distribution". They are tied to a
Team ID; that Team ID must match the `Identity` configured in App Store
Connect for the app.

## Local testing without an Apple identity

```
bun run codesign:mas:dry-run -- --app=/path/to/Built.app
```

This prints the codesign command order without executing anything. Useful for
debugging the walk order against a real built bundle; `Contents/MacOS/bun`
should be the only target signed with `mas-bun.entitlements`.

## Build invocation

The desktop build script invokes the codesign step automatically:

```
ELIZA_MAS_SIGNING_IDENTITY="3rd Party Mac Developer Application: ..." \
ELIZA_MAS_INSTALLER_IDENTITY="3rd Party Mac Developer Installer: ..." \
bun run build:desktop -- --build-variant=store
```

If `ELECTROBUN_SKIP_CODESIGN=1` is set, the MAS step is skipped and the ad-hoc
Eliza signing is applied instead (useful for local dev builds).

## Verifying entitlements on a built bundle

`scripts/mas-smoke.mjs` walks a built `.app`, parses the entitlements off every
Mach-O via `codesign -d --entitlements - --xml`, and asserts that the outer
bundle, the Bun helper, and every other child match the tightened MAS profile
(no `allow-jit` / `allow-unsigned-executable-memory` /
`disable-library-validation` on the parent or on children; `allow-jit` scoped
to `Contents/MacOS/bun` only). Exit code 1 with a per-key diff on any
mismatch.

```
node packages/app-core/scripts/mas-smoke.mjs --app=/Applications/Milady.app
```

Wired into `desktop-build.mjs` behind `--verify-mas` (or `ELIZA_VERIFY_MAS=1`)
so CI store builds run it automatically after `codesign-mas.mjs`. Skipped by
default for local builds. See
[`JUSTIFICATIONS.md`](./JUSTIFICATIONS.md) for the App Review-facing rationale
behind each entitlement.
