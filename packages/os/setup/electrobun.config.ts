// Configures the AOSP setup flasher build and tests.
import type { ElectrobunConfig } from "electrobun/bun";

// The Electrobun bun process (src/main/electrobun-main.ts) starts the in-
// process HTTP backend on an ephemeral port, then constructs a BrowserWindow
// whose `preload` script sets `window.__ELIZA_SERVER_URL__` before the
// Vite-built renderer bundle executes.
//
// The renderer's `src/runtime/server-url.ts` reads that global; without the
// preload injection a production build throws on first fetch instead of
// silently falling back to http://127.0.0.1:3743 (which does not exist in a
// packaged build — the Bun server runs in-process on whatever port the main
// process happened to bind to).

export default {
  app: {
    name: "elizaOS Setup",
    identifier: "ai.elizaos.setup",
    version: process.env.ELIZAOS_RELEASE_VERSION ?? "1.0.0",
    description:
      "Flash elizaOS AOSP builds onto Pixel devices via ADB and fastboot.",
  },
  build: {
    bunVersion: "1.3.14",
    bun: {
      entrypoint: "src/main/electrobun-main.ts",
      // Electrobun's launcher always starts `app/bun/index.js`. Bun otherwise
      // derives the output name from this custom entrypoint and emits
      // `electrobun-main.js`, leaving the packaged app running without its
      // backend or window.
      naming: "index.[ext]",
    },
    views: {},
    copy: {
      // The Vite build (`bun run build`) writes the renderer to `./dist`.
      // Electrobun copies that directory into the packaged app, where the
      // main process serves renderer/index.html over loopback HTTP.
      dist: "renderer",
      "../android/hardware-targets.json": "android/hardware-targets.json",
      "../android/release-trust.json": "android/release-trust.json",
      "../android/installer/install-elizaos-android.sh":
        "android/installer/install-elizaos-android.sh",
      "../scripts/android-installer/validate-release-manifest.ts":
        "scripts/android-installer/validate-release-manifest.ts",
      "../scripts/android-installer/validate-post-flash.sh":
        "scripts/android-installer/validate-post-flash.sh",
      "../scripts/android/install-release.ts":
        "scripts/android/install-release.ts",
      "../scripts/android/release-contract.ts":
        "scripts/android/release-contract.ts",
      "../scripts/android/flash-metadata.ts":
        "scripts/android/flash-metadata.ts",
      "../scripts/android/revocations.ts": "scripts/android/revocations.ts",
      "../scripts/android/install-lock.ts": "scripts/android/install-lock.ts",
      "../scripts/android/post-boot.ts": "scripts/android/post-boot.ts",
      "../scripts/android/runtime-health.ts":
        "scripts/android/runtime-health.ts",
      "../scripts/aosp/lib/android-socket-fetch.ts":
        "scripts/aosp/lib/android-socket-fetch.ts",
    },
    mac: {
      codesign: Boolean(process.env.ELECTROBUN_DEVELOPER_ID),
      notarize: Boolean(
        process.env.ELECTROBUN_APPLEAPIISSUER &&
          process.env.ELECTROBUN_APPLEAPIKEY &&
          process.env.ELECTROBUN_APPLEAPIKEYPATH,
      ),
    },
  },
} satisfies ElectrobunConfig;
