#!/usr/bin/env node
/** Adds only the packaged Eliza extension to a pinned Chromium Android native-messaging allowlist. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMainModule } from "./is-main.mjs";

export const ELIZA_BROWSER_EXTENSION_ID = "pmldpcoefklbdbgmggcejkfoinmjfeio";
const sourcePath = "extensions/browser/api/messaging/message_service.cc";
const featurePath = "extensions/common/extension_features.cc";

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

function main(args) {
  const rootArg = args.indexOf("--source");
  const revisionArg = args.indexOf("--revision");
  const root = rootArg >= 0 ? args[rootArg + 1] : undefined;
  const revision = revisionArg >= 0 ? args[revisionArg + 1] : undefined;
  if (
    !root ||
    !path.isAbsolute(root) ||
    !revision ||
    !/^[a-f0-9]{40}$/.test(revision)
  ) {
    throw new Error(
      "Usage: prepare-chromium-browser.mjs --source /absolute/chromium/src --revision <reviewed-40-character-commit>",
    );
  }
  const actual = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (actual !== revision)
    throw new Error(
      "Chromium checkout does not match the reviewed source revision.",
    );
  const filename = path.join(root, sourcePath);
  const before = fs.readFileSync(filename, "utf8");
  const features = fs.readFileSync(path.join(root, featurePath), "utf8");
  const pristine = execFileSync(
    "git",
    ["-C", root, "show", `${revision}:${sourcePath}`],
    { encoding: "utf8" },
  );
  const pristineFeatures = execFileSync(
    "git",
    ["-C", root, "show", `${revision}:${featurePath}`],
    { encoding: "utf8" },
  );
  const expected = patchNativeMessagingAllowlist(pristine, pristineFeatures);
  if (
    features !== pristineFeatures ||
    (before !== pristine && before !== expected)
  ) {
    throw new Error(
      "Native messaging policy files have unrelated edits; review them before applying the browser integration.",
    );
  }
  fs.writeFileSync(filename, expected);
  process.stdout.write(
    `${JSON.stringify(
      {
        chromiumRevision: revision,
        extensionId: ELIZA_BROWSER_EXTENSION_ID,
        sourcePath,
        beforeSha256: createHash("sha256").update(pristine).digest("hex"),
        afterSha256: createHash("sha256").update(expected).digest("hex"),
        unrestrictedAllowlistBypass: false,
      },
      null,
      2,
    )}\n`,
  );
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
