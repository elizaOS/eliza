import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const safariRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(safariRoot, "../../../..");
const extensionRoot = dirname(safariRoot);
const chromeRoot = join(extensionRoot, "chrome");
const safariSourceRoot = join(safariRoot, ".generated", "extension");
const rmRecursiveScript = join(
  repoRoot,
  "packages/scripts/rm-path-recursive.mjs",
);
const runtimeEntries = ["icons", "popup.css", "popup.html"];
const distEntries = [
  "background.global.js",
  "background.global.js.map",
  "content.global.js",
  "content.global.js.map",
  "popup.js",
  "popup.js.map",
];
const unsupportedSafariPermissions = new Set(["offscreen"]);

function rmRecursive(targetPath) {
  const result = spawnSync(process.execPath, [rmRecursiveScript, targetPath], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to remove generated Safari source ${targetPath} (exit ${result.status})`,
    );
  }
}

rmRecursive(safariSourceRoot);
await mkdir(safariSourceRoot, { recursive: true });

for (const entry of runtimeEntries) {
  await cp(join(chromeRoot, entry), join(safariSourceRoot, entry), {
    recursive: true,
  });
}

await mkdir(join(safariSourceRoot, "dist"), { recursive: true });
for (const entry of distEntries) {
  await cp(
    join(chromeRoot, "dist", entry),
    join(safariSourceRoot, "dist", entry),
  );
}

const chromeManifest = JSON.parse(
  await readFile(join(chromeRoot, "manifest.json"), "utf8"),
);

const safariManifest = {
  ...chromeManifest,
  permissions: chromeManifest.permissions.filter(
    (permission) => !unsupportedSafariPermissions.has(permission),
  ),
};

await writeFile(
  join(safariSourceRoot, "manifest.json"),
  `${JSON.stringify(safariManifest, null, 2)}\n`,
);

console.log(`Prepared Safari extension source at ${safariSourceRoot}`);
