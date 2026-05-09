import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const safariRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionRoot = dirname(safariRoot);
const chromeRoot = join(extensionRoot, "chrome");
const safariSourceRoot = join(safariRoot, ".generated", "extension");
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

await rm(safariSourceRoot, { recursive: true, force: true });
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
