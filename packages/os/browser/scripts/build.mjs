/** Builds the Chromium MV3 extension with the exact native host identity for its platform. */

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { androidNativeHost } from "./android-host.mjs";
import { assetNames } from "./chromium-component.mjs";
import { validateExtensionModules } from "./validate-extension-modules.mjs";

const root = new URL("../", import.meta.url);
const identity = JSON.parse(
  await readFile(new URL("identity.json", root), "utf8"),
);
const certificate = process.env.ELIZA_BROWSER_ANDROID_CERTIFICATE;
if (certificate && !/^[a-fA-F0-9]{64}$/.test(certificate))
  throw new Error(
    "ELIZA_BROWSER_ANDROID_CERTIFICATE must be a SHA-256 hex digest.",
  );
if (process.env.ELIZA_BROWSER_ANDROID_APPLICATION && !certificate)
  throw new Error("Android application requires its signing certificate");
const nativeHost = certificate
  ? androidNativeHost(
      certificate,
      process.env.ELIZA_BROWSER_ANDROID_APPLICATION,
    )
  : "ai.elizaos.browser";
const out = new URL(certificate ? "dist/android/" : "dist/chrome/", root);
await mkdir(out, { recursive: true });
await writeFile(
  new URL("manifest.json", out),
  JSON.stringify(
    {
      manifest_version: 3,
      name: "Eliza Browser Control",
      version: "2.0.8",
      key: identity.chromeDevManifestKey,
      description:
        "Native, authenticated control of this Chromium profile for your Eliza agent.",
      permissions: [
        "tabs",
        "scripting",
        "webNavigation",
        "storage",
        "nativeMessaging",
        "alarms",
      ],
      host_permissions: ["http://*/*", "https://*/*"],
      background: { service_worker: "background.mjs", type: "module" },
    },
    null,
    2,
  ),
);
await writeFile(
  new URL("runtime-config.mjs", out),
  `export const nativeHost = ${JSON.stringify(nativeHost)};\n`,
);
// Keep copied source modules in the same reviewed inventory as the GRIT bundle.
for (const file of assetNames.filter(
  (name) =>
    !["manifest.json", "runtime-config.mjs", "protocol.mjs"].includes(name),
))
  await copyFile(new URL(`src/${file}`, root), new URL(file, out));

const wireBuild = spawnSync(
  "bun",
  [
    "build",
    fileURLToPath(import.meta.resolve("@elizaos/plugin-browser/native-wire")),
    "--target=browser",
    `--outfile=${fileURLToPath(new URL("protocol.mjs", out))}`,
  ],
  { stdio: "inherit" },
);
if (wireBuild.status !== 0) throw new Error("Native wire codec build failed.");

await validateExtensionModules(fileURLToPath(out));
process.stdout.write(`${fileURLToPath(out)}\n`);
