/** Build the product's unpacked MV3 protection module; no installation or signing. */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPUTATION_FEEDS } from "./policy.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
/** @param {string} output
 * @param {{warningDirectory?: string, feeds?: typeof REPUTATION_FEEDS, refreshAlarm?: string, exceptionAlarm?: string}} options
 */
export async function buildBrowserProtection(
  output,
  {
    warningDirectory,
    feeds = REPUTATION_FEEDS,
    refreshAlarm = "eliza-protection-refresh",
    exceptionAlarm = "eliza-protection-exception",
  } = {},
) {
  await mkdir(output, { recursive: true });
  for (const file of [
    "policy.mjs",
    "warning.html",
    "warning.mjs",
    "warning.css",
  ])
    await copyFile(
      join(
        warningDirectory && ["warning.html", "warning.css"].includes(file)
          ? warningDirectory
          : root,
        file,
      ),
      join(output, file),
    );
  const engine = await readFile(join(root, "extension.mjs"), "utf8");
  await writeFile(
    join(output, "background.mjs"),
    engine +
      "\ninstallBrowserProtection({chrome:globalThis.chrome,..." +
      JSON.stringify({ feeds, refreshAlarm, exceptionAlarm }) +
      "});\n",
  );
  const manifest = {
    manifest_version: 3,
    name: "Eliza website protection",
    version: "1.0.0",
    description: "Local threat-domain blocking for Chromium.",
    permissions: [
      "declarativeNetRequest",
      "storage",
      "alarms",
      "tabs",
      "webNavigation",
    ],
    host_permissions: ["http://*/*", "https://*/*"],
    background: { service_worker: "background.mjs", type: "module" },
    web_accessible_resources: [
      { resources: ["warning.html"], matches: ["<all_urls>"] },
    ],
  };
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const escapeHtml = (s) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const licenses = await Promise.all(
    ["phishing-database.txt", "hagezi-gpl-3.0.txt"].map((f) =>
      readFile(join(root, "licenses", f), "utf8"),
    ),
  );
  await writeFile(
    join(output, "licenses.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Protection sources and licenses</title><h1>Sources and licenses</h1><p><a href="https://github.com/Phishing-Database/Phishing.Database">Phishing.Database source</a> · <a href="https://github.com/hagezi/dns-blocklists">HaGeZi source</a></p>${licenses.map((s) => "<pre>" + escapeHtml(s) + "</pre>").join("")}</html>`,
  );
  return { output, installed: false, signed: false };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    await buildBrowserProtection(
      process.argv[2]
        ? resolve(process.argv[2])
        : (await import("../../../scripts/lib/test-output.ts")).testOutputPath(
            "browser-protection",
            "build",
          ),
    ),
  );

/** Add the complete optional protection resource set without expanding other capabilities. */
export async function composeProtectionAssets(assets, options = {}) {
  const manifest = JSON.parse(assets["manifest.json"]);
  if (
    manifest.permissions.includes("declarativeNetRequest") ||
    manifest.web_accessible_resources
  ) {
    throw new Error("Unexpected pre-existing protection capabilities");
  }
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const temporary = await mkdtemp(join(tmpdir(), "eliza-protection-"));
  try {
    await buildBrowserProtection(temporary, options);
    const result = { ...assets };
    for (const file of [
      "policy.mjs",
      "warning.html",
      "warning.mjs",
      "warning.css",
      "licenses.html",
    ]) {
      result[file] = await readFile(join(temporary, file));
    }
    result["protection.mjs"] = await readFile(
      join(temporary, "background.mjs"),
    );
    result["background.mjs"] = Buffer.concat([
      assets["background.mjs"],
      Buffer.from('\nimport "./protection.mjs";\n'),
    ]);
    manifest.permissions.push("declarativeNetRequest");
    manifest.web_accessible_resources = [
      { resources: ["warning.html"], matches: ["<all_urls>"] },
    ];
    result["manifest.json"] = Buffer.from(
      JSON.stringify(manifest, null, 2) + "\n",
    );
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
