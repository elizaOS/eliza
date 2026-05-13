import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const safariRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionRoot = dirname(safariRoot);
const chromeRoot = join(extensionRoot, "chrome");
const requiredChromeArtifact = join(chromeRoot, "dist", "background.global.js");
const explicitBuild = process.env.ELIZA_BUILD_SAFARI_EXTENSION === "1";

function skip(message) {
  console.log(`[example-browser-extension-safari] build skipped: ${message}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: safariRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.platform !== "darwin") {
  skip("Safari extension conversion requires macOS with Xcode");
  process.exit(0);
}

if (!existsSync(requiredChromeArtifact)) {
  const message =
    "Chrome extension dist artifacts are missing; run the chrome build first";
  if (explicitBuild) {
    console.error(`[example-browser-extension-safari] ${message}`);
    process.exit(1);
  }
  skip(message);
  process.exit(0);
}

const converter = spawnSync(
  "xcrun",
  ["--find", "safari-web-extension-converter"],
  {
    encoding: "utf8",
  },
);
if (converter.status !== 0) {
  const message = "xcrun safari-web-extension-converter is unavailable";
  if (explicitBuild) {
    console.error(`[example-browser-extension-safari] ${message}`);
    process.exit(converter.status ?? 1);
  }
  skip(message);
  process.exit(0);
}

run("npm", ["run", "convert"]);
run("node", ["scripts/fix-generated-safari.mjs"]);
console.log("Now open the Xcode project in safari/Chat with Webpage/");
