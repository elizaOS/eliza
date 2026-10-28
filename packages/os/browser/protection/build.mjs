/** Build the product's unpacked MV3 protection module; no installation or signing. */

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPUTATION_FEEDS } from "./policy.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const escapeHtml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Text for the `{{key}}` slots of warning.html. Values are plain text. */
export function warningCopy(
  { assistantName = "Eliza", copy = {} } = {},
  feeds = REPUTATION_FEEDS,
) {
  const defaults = {
    title: `Website warning — ${assistantName}`,
    heading: "This website has been reported as harmful.",
    stopped: `${assistantName} stopped it before it opened.`,
    mistake:
      "Confirm the address with the company using contact information you already trust. Opening it does not mark it as safe.",
    feeds: `Community lists: ${new Intl.ListFormat("en", { type: "conjunction" }).format(feeds.map((feed) => `${feed.source} (${feed.license})`))}.`,
    limits: "Domain-list protection cannot detect every threat.",
  };
  for (const [key, value] of Object.entries(copy))
    if (!Object.hasOwn(defaults, key) || typeof value !== "string")
      throw Error(`Unknown or invalid warning copy: ${key}`);
  return { ...defaults, ...copy };
}

/** Fill `{{key}}` slots; a page without slots is returned unchanged. */
export function renderWarningPage(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key))
      throw Error(`Unknown warning page slot: ${key}`);
    return escapeHtml(values[key]);
  });
}

/** @param {string} output
 * @param {{warningDirectory?: string, warning?: {assistantName?: string, copy?: Partial<Record<"title"|"heading"|"stopped"|"mistake"|"feeds"|"limits", string>>}, feeds?: typeof REPUTATION_FEEDS, refreshAlarm?: string, exceptionAlarm?: string, advisory?: {referenceDomains?: string[], copy?: Record<string,string>}}} options
 */
export async function buildBrowserProtection(
  output,
  {
    warningDirectory,
    warning,
    advisory,
    feeds = REPUTATION_FEEDS,
    refreshAlarm = "eliza-protection-refresh",
    exceptionAlarm = "eliza-protection-exception",
  } = {},
) {
  for (const feed of feeds)
    if (!feed.notice) throw Error(`Feed ${feed.id} has no license notice`);
  const copy = warningCopy(warning, feeds);
  await mkdir(output, { recursive: true });
  for (const file of ["policy.mjs", "warning.mjs", "warning.css"])
    await copyFile(
      join(
        warningDirectory && file === "warning.css" ? warningDirectory : root,
        file,
      ),
      join(output, file),
    );
  await writeFile(
    join(output, "warning.html"),
    renderWarningPage(
      await readFile(join(warningDirectory ?? root, "warning.html"), "utf8"),
      copy,
    ),
  );
  const bundled = spawnSync(
    "bun",
    [
      "build",
      join(root, "advisory.mjs"),
      "--target=browser",
      `--outfile=${join(output, "advisory.mjs")}`,
    ],
    { encoding: "utf8" },
  );
  if (bundled.status !== 0)
    throw Error(`Advisory build failed: ${bundled.stderr}`);
  const engine = await readFile(join(root, "extension.mjs"), "utf8");
  // Attribution fields stay at build time; a local notice path never ships.
  const runtimeFeeds = feeds.map(({ notice, homepage, ...feed }) => feed);
  await writeFile(
    join(output, "background.mjs"),
    engine +
      "\nexport const protection = installBrowserProtection({chrome:globalThis.chrome,..." +
      JSON.stringify({
        feeds: runtimeFeeds,
        refreshAlarm,
        exceptionAlarm,
        advisory,
      }) +
      "});\n",
  );
  const manifest = {
    manifest_version: 3,
    name: "Eliza website protection",
    version: "1.0.1",
    description: "Local threat-domain blocking for Chromium.",
    permissions: [
      "declarativeNetRequest",
      ...(advisory ? ["scripting"] : []),
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
  // A relative notice names a file in licenses/; consumer feeds may give an absolute path.
  const licenses = await Promise.all(
    feeds.map(
      async (feed) =>
        `${feed.source} (${feed.license})\n${await readFile(resolve(root, "licenses", feed.notice), "utf8")}`,
    ),
  );
  for (const [name, file] of [
    ["punycode", "LICENSE-MIT.txt"],
    ["tldts", "LICENSE"],
    ["tldts-core", "LICENSE"],
  ]) {
    const manifestPath =
      name === "tldts-core"
        ? createRequire(import.meta.resolve("tldts/package.json")).resolve(
            "tldts-core/package.json",
          )
        : fileURLToPath(import.meta.resolve(`${name}/package.json`));
    licenses.push(
      `${name}\n${await readFile(join(manifestPath, "..", file), "utf8")}`,
    );
  }
  await writeFile(
    join(output, "licenses.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Protection sources and licenses</title><h1>Sources and licenses</h1><p>${feeds.map((feed) => `<a href="${escapeHtml(feed.homepage ?? feed.licenseUrl)}">${escapeHtml(feed.source)} source</a>`).join(" · ")}</p>${licenses.map((s) => "<pre>" + escapeHtml(s) + "</pre>").join("")}</html>`,
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

/** Add the complete optional protection resource set without expanding other capabilities.
 * @param {Record<string, Buffer>} assets
 * @param {Parameters<typeof buildBrowserProtection>[1] & {nativeAccountTransport?: boolean}} options
 */
export async function composeProtectionAssets(
  assets,
  { nativeAccountTransport = false, ...options } = {},
) {
  if (nativeAccountTransport && !options.advisory)
    throw Error("Native account transport requires website advice");
  const manifest = JSON.parse(assets["manifest.json"].toString());
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
      "advisory.mjs",
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
      Buffer.from(
        nativeAccountTransport
          ? '\nimport { protection } from "./protection.mjs";\nhandleCommand.attachProtectionAdvisory(protection.advisory);\n'
          : '\nimport "./protection.mjs";\n',
      ),
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
