# elizaOS Android

AOSP vendor overlays and build orchestration for Cuttlefish and supported Pixel
products. A full image build requires a Linux x86_64 builder, the pinned AOSP
checkout, Android build dependencies, and Eliza workspace dependencies. Cuttlefish
launches require KVM except for the RISC-V TCG path.

From the repository root:

```bash
make -C packages/os/android bootstrap AOSP_ROOT=/path/to/aosp
make -C packages/os/android bootanimation
make -C packages/os/android build ARCH=x86_64 AOSP_ROOT=/path/to/aosp
```

`ARCH` accepts `x86_64`, `arm64`, or `riscv64`. `build` stages native inference,
rebuilds the privileged APK, syncs the vendor tree, builds AOSP, then launches and
validates Cuttlefish. `make -C packages/os/android help` lists hardware-specific
commands. Building an image does not flash a physical device.

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

Staging verifies hashes, upstream APK signatures, package identities and versions.
AOSP sync rejects missing or changed artifacts. Both apps remain nonprivileged and
upstream-signed. The current Chromium pin is an x86_64 development snapshot, not a
release-qualified browser; ARM64 and RISC-V need separately qualified artifacts.
Bitwarden remains locked until the user signs in and enables Android Autofill and
passkeys. Its F-Droid build requires manual vault sync. The launcher's Passwords
screen provides setup, backup and recovery guidance without accessing vault data.

Production background browser control requires an owned Desktop Android Chromium
build. Run `make -C packages/os/android prepare-chromium-browser
ARGS="--source /absolute/chromium/src --revision <reviewed-commit>"` before building
`chrome_public_apk` with Desktop Android extensions enabled. This adds only Eliza's
packaged extension to Chromium's native-messaging allowlist; the unrestricted
test bypass remains disabled. The snapshot above does not include that patch.
Set `ELIZA_CHROMIUM_CERT_SHA256` to the final browser signer when building the
launcher and `ELIZA_BROWSER_ANDROID_CERTIFICATE` to the launcher signer when
building the extension. Release launchers require a verified, policy-installed
extension; unpacked extensions are accepted only by debug launchers.
