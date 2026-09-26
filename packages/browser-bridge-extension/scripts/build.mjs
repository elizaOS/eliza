/** Builds the Chromium MV3 extension with the exact native host identity for its platform. */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const identity = JSON.parse(
  await readFile(new URL("identity.json", root), "utf8"),
);
const certificate = process.env.ELIZA_BROWSER_ANDROID_CERTIFICATE;
if (certificate && !/^[a-fA-F0-9]{64}$/.test(certificate))
  throw new Error(
    "ELIZA_BROWSER_ANDROID_CERTIFICATE must be a SHA-256 hex digest.",
  );
const out = new URL(certificate ? "dist/android/" : "dist/chrome/", root);
await mkdir(out, { recursive: true });
await writeFile(
  new URL("manifest.json", out),
  JSON.stringify(
    {
      manifest_version: 3,
      name: "Eliza Browser Control",
      version: "2.0.4",
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
  `export const nativeHost = ${JSON.stringify(certificate ? { application: "ai.elizaos.app", androidCertificates: [certificate.toUpperCase()] } : "ai.elizaos.browser")};\n`,
);
for (const file of ["background.mjs", "commands.mjs", "native-connection.mjs"])
  await copyFile(new URL(`src/${file}`, root), new URL(file, out));
process.stdout.write(`${fileURLToPath(out)}\n`);

const wireBuild = spawnSync(
  "bun",
  [
    "build",
    fileURLToPath(
      new URL("../../plugins/plugin-browser/src/native-wire.ts", root),
    ),
    "--target=browser",
    `--outfile=${fileURLToPath(new URL("protocol.mjs", out))}`,
  ],
  { stdio: "inherit" },
);
if (wireBuild.status !== 0) throw new Error("Native wire codec build failed.");
