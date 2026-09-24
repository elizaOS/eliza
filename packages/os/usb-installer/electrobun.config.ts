// Configures the USB installer build, server, and tests.
import type { ElectrobunConfig } from "electrobun/bun";

const releasePublicKey =
  process.env.ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64;
const releasePublicKeyFingerprint =
  process.env.ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256;
const revokedReleaseKeyFingerprints =
  process.env.ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S ?? "";

export default {
  app: {
    name: "elizaOS USB Installer",
    identifier: "ai.elizaos.usb-installer",
    version: process.env.ELIZAOS_RELEASE_VERSION ?? "0.1.0",
    description: "Prepare bootable elizaOS USB installers",
  },
  build: {
    bun: {
      // Electrobun's launcher loads Resources/app/bun/index.js.
      entrypoint: "electrobun/index.ts",
      define:
        releasePublicKey && releasePublicKeyFingerprint
          ? {
              __ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64__:
                JSON.stringify(releasePublicKey),
              __ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256__:
                JSON.stringify(releasePublicKeyFingerprint),
              __ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S__:
                JSON.stringify(revokedReleaseKeyFingerprints),
            }
          : {},
    },
    bunVersion: "1.3.14",
    views: {},
    copy: { dist: "dist" },
    mac: {
      codesign: Boolean(process.env.ELECTROBUN_DEVELOPER_ID),
      notarize: Boolean(
        process.env.ELECTROBUN_APPLEAPIISSUER &&
          process.env.ELECTROBUN_APPLEAPIKEY &&
          process.env.ELECTROBUN_APPLEAPIKEYPATH,
      ),
      entitlements: {
        "com.apple.security.cs.allow-unsigned-executable-memory": true,
        "com.apple.security.network.client": true,
        "com.apple.security.automation.apple-events": true,
      },
    },
    linux: {},
    win: {},
  },
  scripts: {
    preBuild: "scripts/build-renderer.ts",
  },
} satisfies ElectrobunConfig;
