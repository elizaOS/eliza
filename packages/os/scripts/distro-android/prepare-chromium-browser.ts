#!/usr/bin/env node
/** Applies the reviewed, integrity-checked Android component integration to a pristine pinned checkout. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveElizaSourceRoot } from "../eliza-source.ts";

export const ELIZA_BROWSER_EXTENSION_ID = "pmldpcoefklbdbgmggcejkfoinmjfeio";

export function patchNativeMessagingAllowlist(source, features) {
  if (
    !/BASE_FEATURE\(kApiDesktopAndroidNativeMessagingBypassExtensionAllowlist,\s*base::FEATURE_DISABLED_BY_DEFAULT\)/.test(
      features,
    )
  ) {
    throw new Error(
      "Chromium must retain its disabled-by-default native-messaging allowlist bypass.",
    );
  }
  if (
    !source.includes(
      "!kAndroidNativeMessagingAllowedExtensionIds.contains(extension->id())",
    )
  ) {
    throw new Error(
      "Chromium's native-messaging authorization guard changed; review this revision before building.",
    );
  }
  const pattern =
    /(constexpr auto kAndroidNativeMessagingAllowedExtensionIds =\s*base::MakeFixedFlatSet<std::string_view>\(\{)([\s\S]*?)(\}\);)/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1)
    throw new Error(
      "Expected exactly one Chromium Android native-messaging extension allowlist.",
    );
  const body = matches[0][2];
  if (body.includes(`"${ELIZA_BROWSER_EXTENSION_ID}"`)) return source;
  return source.replace(
    pattern,
    `$1$2    // elizaOS packaged browser bridge; the native host verifies browser and extension identities.\n    "${ELIZA_BROWSER_EXTENSION_ID}",\n$3`,
  );
}

export async function prepareChromiumBrowser({
  source,
  extension,
  out,
  certificate,
  revision,
}) {
  for (const [name, value] of Object.entries({ source, extension, out })) {
    if (!value || !path.isAbsolute(value))
      throw new Error(`${name} must be an absolute path.`);
  }
  if (!/^[a-f0-9]{64}$/i.test(certificate ?? ""))
    throw new Error("The final launcher certificate SHA-256 is required.");
  const sourceRoot = fs.realpathSync(source);
  const outputRoot = path.resolve(out);
  if (
    outputRoot === sourceRoot ||
    outputRoot.startsWith(`${sourceRoot}${path.sep}`)
  )
    throw new Error("Component output must be outside the Chromium checkout.");
  if (fs.existsSync(outputRoot))
    throw new Error("Component output directory must be new.");
  const script = path.join(
    resolveElizaSourceRoot(),
    "packages/browser-bridge-extension/scripts/chromium-component.mjs",
  );
  const generator = await import(pathToFileURL(script).href);
  if (revision !== undefined && revision !== generator.pin.revision)
    throw new Error("Chromium revision must match the reviewed component pin.");
  await generator.readReviewedChromiumSources(sourceRoot);
  execFileSync(
    process.execPath,
    [
      script,
      "--source",
      sourceRoot,
      "--extension",
      extension,
      "--out",
      outputRoot,
      "--platform",
      "android",
      "--certificate",
      certificate,
    ],
    { stdio: "pipe" },
  );
  const report = JSON.parse(
    fs.readFileSync(
      path.join(outputRoot, "eliza-component-overlay.json"),
      "utf8",
    ),
  );
  const patch = path.join(outputRoot, "eliza-component.patch");
  if (generator.sha256(fs.readFileSync(patch)) !== report.patchSha256)
    throw new Error("Generated component patch changed before application.");
  // No older allowlist-only patch may precede this pristine-source recheck.
  await generator.readReviewedChromiumSources(sourceRoot);
  execFileSync("git", ["-C", sourceRoot, "apply", "--check", patch], {
    stdio: "pipe",
  });
  execFileSync("git", ["-C", sourceRoot, "apply", patch], { stdio: "pipe" });
  for (const [relative, expected] of Object.entries(report.outputs)) {
    if (
      generator.sha256(fs.readFileSync(path.join(sourceRoot, relative))) !==
      expected
    )
      throw new Error(`Applied component output mismatch: ${relative}`);
  }
  return {
    ...report,
    launcherSignerSha256: certificate.toLowerCase(),
    releaseQualified: false,
  };
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  const names = new Set([
    "source",
    "extension",
    "out",
    "certificate",
    "revision",
  ]);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].replace(/^--/, "");
    if (
      !args[i].startsWith("--") ||
      !names.has(name) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--") ||
      options[name]
    )
      throw new Error(`Invalid preparation argument: ${args[i]}`);
    options[name] = args[i + 1];
  }
  console.log(JSON.stringify(await prepareChromiumBrowser(options), null, 2));
}

if (import.meta.main) await main();
