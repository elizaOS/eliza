/** Prepare certificate-bound component assets; does not compile or install Chromium. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class BrowserInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserInputError";
  }
}

/** Trusted host supplies tools, environment, reviewed checkout and optional asset policy. */
export async function prepareAndroidConsumerInputs({
  source,
  expectedCommit,
  apk,
  output,
  application,
  apksigner,
  environment = process.env,
  composeAssets,
}) {
  for (const value of [source, apk, output])
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw new BrowserInputError(
        "Source, APK and output require absolute paths",
      );
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || ""))
    throw new BrowserInputError("A reviewed source commit is required");
  if (
    typeof application !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(application)
  )
    throw new BrowserInputError("An Android application ID is required");
  if (composeAssets !== undefined && typeof composeAssets !== "function")
    throw new BrowserInputError("Asset composition must be a host function");
  if (fs.existsSync(output))
    throw new BrowserInputError("Output directory must be new");
  const git = (...args) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  if (
    fs.realpathSync(git("rev-parse", "--show-toplevel")) !==
    fs.realpathSync(source)
  )
    throw new BrowserInputError("Source must be the checkout root");
  const checkSource = () => {
    if (git("rev-parse", "HEAD") !== expectedCommit)
      throw new BrowserInputError("Source differs from the reviewed commit");
    if (
      git(
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--",
        "packages/os/browser",
        "packages/os/scripts/android/prepare-chromium-browser.ts",
        "plugins/plugin-browser",
      )
    )
      throw new BrowserInputError("Browser build inputs must be clean");
  };
  checkSource();
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const apkSha256 = hash(fs.readFileSync(apk));
  const signature = execFileSync(apksigner, ["verify", "--print-certs", apk], {
    encoding: "utf8",
    env: environment,
  });
  const certificates = [
    ...signature.matchAll(
      /Signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9]{64})/g,
    ),
  ].map((match) => match[1].toLowerCase());
  if (certificates.length !== 1)
    throw new BrowserInputError("Exactly one verified APK signer is required");
  const certificateSha256 = certificates[0];
  const browser = path.join(source, "packages/os/browser");
  execFileSync(
    process.execPath,
    ["--conditions=eliza-source", path.join(browser, "scripts/build.mjs")],
    {
      cwd: source,
      stdio: "pipe",
      env: {
        ...environment,
        ELIZA_BROWSER_ANDROID_APPLICATION: application,
        ELIZA_BROWSER_ANDROID_CERTIFICATE: certificateSha256,
      },
    },
  );
  const generator = await import(
    pathToFileURL(path.join(browser, "scripts/chromium-component.mjs")).href
  );
  let assets = Object.fromEntries(
    generator.assetNames.map((name) => [
      name,
      fs.readFileSync(path.join(browser, "dist/android", name)),
    ]),
  );
  generator.validateAssets(assets, "android", certificateSha256, application);
  fs.mkdirSync(output);
  let composition;
  if (composeAssets) {
    const result = await composeAssets({ assets, output });
    assets = result.assets;
    composition = result.provenance;
  }
  generator.validateAssets(assets, "android", certificateSha256, application);
  checkSource();
  if (hash(fs.readFileSync(apk)) !== apkSha256)
    throw new BrowserInputError("APK changed while preparing browser inputs");
  const extension = path.join(output, "extension");
  fs.mkdirSync(extension);
  for (const [name, bytes] of Object.entries(assets)) {
    if (
      !name ||
      path.basename(name) !== name ||
      name.includes("\\") ||
      name === "." ||
      name === ".."
    )
      throw new BrowserInputError("Invalid component asset name");
    fs.writeFileSync(path.join(extension, name), bytes, { flag: "wx" });
  }
  return {
    sourceCommit: expectedCommit,
    certificateSha256,
    apkSha256,
    chromiumRevision: generator.pin.revision,
    resources: Object.fromEntries(
      Object.entries(assets).map(([name, bytes]) => [name, hash(bytes)]),
    ),
    composition,
  };
}
