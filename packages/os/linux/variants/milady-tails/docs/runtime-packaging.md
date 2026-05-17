# Runtime Packaging

The Milady/Electrobun app is staged into the live-build overlay at:

```text
tails/config/chroot_local-includes/usr/share/elizaos/milady-app/
```

The `9100-install-milady` chroot hook copies that tree to `/opt/milady`.
The staged app is intentionally not slimmed in this step; the current goal is
to make the bundled runtime auditable before any ISO build runs.

## Manifest

`scripts/prepare-milady-app-overlay.mjs` writes:

```text
Resources/app/elizaos-live-overlay-manifest.json
```

inside the staged app root. The manifest is an SBOM-style audit record for the
runtime overlay. It records:

- the staged app root and installed app root (`/opt/milady`)
- source git commit and generation time
- package manifest count plus package inventory from `eliza-dist/node_modules`
- generated live packages and optional plugin stubs
- key app and OS entrypoints
- expected API and renderer ports
- known repository-resolution strings that must not regress to Milady defaults

Optional connector stubs are deliberately listed under
`generated.optionalPluginStubs`. If a full package is present, the manifest
records that the stub was not generated. If a live stub package exists without a
matching manifest entry, validation fails.

## Validation

Run the cheap validator after staging the app:

```sh
node scripts/validate-runtime-overlay.mjs --stage tails/config/chroot_local-includes/usr/share/elizaos/milady-app
```

The validator does not build an ISO. It checks:

- required app entrypoints such as `bin/launcher`, `bin/bun`,
  `Resources/app/eliza-dist/entry.js`, and renderer `index.html`
- OS overlay entrypoints such as `/usr/local/bin/milady`, the user service
  launchers, the renderer server, and systemd units
- manifest package count against actual `package.json` files
- generated optional plugin stubs and undeclared live stub packages
- dependency symlinks from the app root and `bin/`
- elizaOS branding in `version.json` and `brand-config.json`
- hard-coded Milady repo/app resolution strings in renderer and brand config
- API and renderer port defaults across the manifest, launcher wrappers,
  renderer server, and WebKit shell

`scripts/prepare-milady-app-overlay.mjs --check` still verifies that the staged
overlay has already been patched by the prepare script. The validator is the
more explicit runtime-packaging audit and should be used when the staged app is
present.

## Remaining Debt

This slice does not solve package slimming. The app still carries the bundled
runtime tree produced by the desktop build, plus compatibility stubs for optional
connectors that are not part of the live USB base runtime.

The manifest is a static audit record, not a runtime attestation. It can prove
that staged files and defaults are internally consistent before a build; it
cannot prove that the final ISO boots, that Electrobun launches successfully, or
that no dynamic runtime import path is missed.
