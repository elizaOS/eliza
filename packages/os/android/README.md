# elizaOS Android

AOSP vendor overlays and build orchestration for Cuttlefish and supported Pixel
products. A full image build requires a Linux x86_64 builder, the pinned AOSP
checkout, Android build dependencies, and Eliza workspace dependencies. Cuttlefish
launches require KVM except for the RISC-V TCG path.

From the repository root:

```bash
make -C packages/os/android bootstrap AOSP_ROOT=/path/to/aosp
make -C packages/os/android bootanimation
make -C packages/os/android build ARCH=x86_64 AOSP_ROOT=/path/to/aosp \
  ARGS="--allow-development-browser"
```

`ARCH` accepts `x86_64`, `arm64`, or `riscv64`. `build` stages native inference,
rebuilds the privileged APK, syncs the vendor tree, builds AOSP, then launches and
validates Cuttlefish. `make -C packages/os/android help` lists hardware-specific
commands. Building an image does not flash a physical device.
The Pixel 11 Pro lock targets stock B1 (`CD1A.260905.001.B1`) with the pinned
Android 17 `cp2a` release and vendor API `202604`. Its hashed vendor reference is
a build input; physical installation still requires qualification and a signed contract.
Builds leave existing Cuttlefish sessions running. Stop selected instances
explicitly when reclaiming memory before a build.

Application sources resolve to the enclosing Eliza checkout. Set
`ELIZAOS_ELIZA_ROOT` to use another checkout; a standalone OS checkout instead
looks under `.eliza-source`. Native scripts and APK assets live under
`packages/app`, not this vendor tree. Licensed device inputs and release-signing
material must be supplied separately.

Browser images require the full Chromium APK and Bitwarden APK pinned in
[`vendor/eliza/manifests/browser-apps.json`](vendor/eliza/manifests/browser-apps.json).
Download the upstream artifacts named there, extract Chromium's APK, then stage
with Android SDK `apksigner` and `aapt` on `PATH`:

```bash
make -C packages/os/android stage-browser-apps ARCH=x86_64 \
  ARGS="--chromium-apk /absolute/ChromePublic.apk --bitwarden-apk /absolute/bitwarden.apk --allow-development-browser"
```

Staging verifies hashes, pinned APK signatures, package identities, versions and ABI.
AOSP sync rejects missing or changed artifacts. Both apps remain nonprivileged and
signed by their pinned publishers. Chromium pins select separate x86_64 and ARM64 development
snapshots and stage them under architecture-specific directories. Use `ARCH=arm64`
for Pixel builds. Neither snapshot is release-qualified; RISC-V has no pinned artifact.
Bitwarden remains locked until the user signs in and enables Android Autofill and
passkeys. Its F-Droid build requires manual vault sync. The launcher's Passwords
screen provides setup, backup and recovery guidance without accessing vault data.

Owned background browser control requires the reviewed Desktop Android Chromium
component build. Build the bridge extension with
`ELIZA_BROWSER_ANDROID_CERTIFICATE` set to the launcher signer, then prepare a
pristine checkout using the component generator (not the old allowlist-only patch):

```bash
make -C packages/os/android prepare-chromium-browser \
  ARGS="--source /absolute/chromium/src --extension /absolute/extension/dist --out /absolute/new-overlay --certificate <launcher-sha256>"
```

Preparation checks the generator's pinned revision/source hashes and applies its
six-resource component overlay, retaining default native verification. Build
`chrome_public_apk` with explicit Desktop Android GN arguments afterward.

Manifest schema 3 reserves Chromium `kind: "owned-component"` variants for exact
APK hash, signer, package, version and ABI pins. Their `component` binds schema 1,
Chromium revision, extension ID, launcher signer and a hashed provenance reference.
That document binds the APK identity, reviewed overlay/patch, six extension assets
and GN arguments through `{path, sha256}` references under
`manifests/browser-provenance/<arch>/`. This adds integrity evidence, not another
signature authority. No owned APK pin is supplied yet. Stable owned admission and
runtime qualification claims remain refused until a real qualification contract
and production signing inputs exist; staging never claims release qualification.

Current snapshots and future owned debug candidates require explicit
`--allow-development-browser` at staging, build and sync. Only `userdebug`/`eng`
AOSP targets may admit them. Sync rechecks copied bytes before replacing vendor
output. Launcher builds derive `ELIZA_CHROMIUM_CERT_SHA256` from the selected pin
and reject a conflicting override. Bitwarden's upstream source/signature contract
is unchanged. Development unpacked-extension proofs do not qualify release builds.
