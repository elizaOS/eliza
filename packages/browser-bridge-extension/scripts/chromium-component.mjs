#!/usr/bin/env node
/** Generates a pinned Chromium overlay with an integrity-checked built-in Eliza extension. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyIndexedDBLockOrder } from "./chromium/indexeddb-lock-order.mjs";
import { applyStandaloneCredMan } from "./chromium/standalone-credman.mjs";
import { applyStandaloneCredManTests } from "./chromium/standalone-credman-tests.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const pin = JSON.parse(
  await readFile(path.join(here, "chromium/upstream.json"), "utf8"),
);
export const EXTENSION_ID = "pmldpcoefklbdbgmggcejkfoinmjfeio";
export const assetNames = [
  "background.mjs",
  "commands.mjs",
  "manifest.json",
  "native-connection.mjs",
  "protocol.mjs",
  "runtime-config.mjs",
];
const resourceIds = {
  "background.mjs": "IDR_ELIZA_BROWSER_BACKGROUND",
  "commands.mjs": "IDR_ELIZA_BROWSER_COMMANDS",
  "manifest.json": "IDR_ELIZA_BROWSER_MANIFEST",
  "native-connection.mjs": "IDR_ELIZA_BROWSER_CONNECTION",
  "protocol.mjs": "IDR_ELIZA_BROWSER_PROTOCOL",
  "runtime-config.mjs": "IDR_ELIZA_BROWSER_NATIVE_CONFIG",
};
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2)
    throw new Error(`Reviewed Chromium hook changed: ${label}`);
  return source.replace(before, after);
}
function insertInclude(source, include) {
  const first = source.indexOf("#include ");
  if (first < 0) throw new Error("Missing Chromium include boundary");
  return `${source.slice(0, first)}#include "${include}"\n${source.slice(first)}`;
}
export function validateAssets(assets, platform, certificate) {
  if (!["linux", "android"].includes(platform))
    throw new Error("Platform must be linux or android");
  if (
    JSON.stringify(Object.keys(assets).sort()) !==
    JSON.stringify([...assetNames].sort())
  )
    throw new Error(
      "Extension resource inventory changed; review every resource before embedding",
    );
  for (const bytes of Object.values(assets)) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0)
      throw new Error("Missing extension resource bytes");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  const manifest = JSON.parse(assets["manifest.json"].toString("utf8"));
  const identity = createHash("sha256")
    .update(Buffer.from(manifest.key ?? "", "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) =>
      String.fromCharCode(97 + Number.parseInt(digit, 16)),
    );
  const keys = [
    "manifest_version",
    "name",
    "version",
    "key",
    "description",
    "permissions",
    "host_permissions",
    "background",
  ];
  if (
    identity !== EXTENSION_ID ||
    manifest.manifest_version !== 3 ||
    !Array.isArray(manifest.permissions) ||
    !Array.isArray(manifest.host_permissions) ||
    Object.keys(manifest).some((key) => !keys.includes(key)) ||
    JSON.stringify(manifest.background) !==
      JSON.stringify({ service_worker: "background.mjs", type: "module" }) ||
    JSON.stringify([...manifest.permissions].sort()) !==
      JSON.stringify([
        "alarms",
        "nativeMessaging",
        "scripting",
        "storage",
        "tabs",
        "webNavigation",
      ]) ||
    JSON.stringify(manifest.host_permissions) !==
      JSON.stringify(["http://*/*", "https://*/*"])
  )
    throw new Error(
      "Extension identity or reviewed manifest capabilities changed",
    );
  const expectedHost =
    platform === "android"
      ? {
          application: "ai.elizaos.app",
          androidCertificates: [String(certificate).toUpperCase()],
        }
      : "ai.elizaos.browser";
  if (platform === "android" && !/^[0-9a-f]{64}$/i.test(certificate ?? ""))
    throw new Error("Android app signing certificate SHA-256 is required");
  if (
    assets["runtime-config.mjs"].toString("utf8") !==
    `export const nativeHost = ${JSON.stringify(expectedHost)};\n`
  )
    throw new Error(
      "Native host configuration does not match the pinned platform and app certificate",
    );
}

/** Pure transformation: all upstream bytes must match the reviewed revision before anything is emitted. */
export async function generateComponentOverlay({
  sources,
  assets,
  platform,
  certificate,
  revision,
}) {
  if (revision !== pin.revision)
    throw new Error(
      "Unsupported Chromium revision; explicit source review required",
    );
  for (const [filename, expected] of Object.entries(pin.sha256))
    if (sha256(sources[filename] ?? "") !== expected)
      throw new Error(`Chromium source integrity mismatch: ${filename}`);
  validateAssets(assets, platform, certificate);
  const files = {};
  const edit = (filename, transform) => {
    files[filename] = transform(files[filename] ?? sources[filename]);
  };
  // Bindings generation otherwise starts one worker per host CPU, ignoring
  // container quotas. Keep each Ninja action serial so Ninja owns concurrency.
  edit("third_party/blink/renderer/bindings/BUILD.gn", (source) =>
    replaceOnce(
      source,
      "    outputs = invoker.outputs\n\n    args = [\n",
      '    outputs = invoker.outputs\n\n    args = [\n      "--single_process",\n',
      "bounded Blink bindings generation",
    ),
  );
  const prefix = "chrome/browser/extensions/";
  const verifier = `${prefix}eliza_component_verifier.h`;
  const integrity = `${prefix}eliza_component_integrity.h`;
  files[integrity] = (
    await readFile(path.join(here, "chromium/integrity.h.in"), "utf8")
  ).replace(
    "@@RESOURCES@@",
    assetNames
      .map(
        (name) =>
          `  {"${name}", ${assets[name].length}, "${sha256(assets[name])}"},`,
      )
      .join("\n"),
  );
  files[verifier] = (
    await readFile(path.join(here, "chromium/verifier.h.in"), "utf8")
  ).replace(
    "@@BUNDLE_RESOURCES@@",
    assetNames.map((name) => `  {"${name}", ${resourceIds[name]}},`).join("\n"),
  );
  for (const name of assetNames)
    files[`chrome/browser/resources/eliza_browser/${name}`] = assets[name];
  edit("chrome/browser/resources/component_extension_resources.grd", (source) =>
    replaceOnce(
      source,
      "    <includes>\n",
      "    <includes>\n" +
        assetNames
          .map(
            (name) =>
              `      <include name="${resourceIds[name]}" file="eliza_browser/${name}" resource_path="eliza_browser/${name}" type="BINDATA" />\n`,
          )
          .join(""),
      "GRIT inventory",
    ),
  );
  edit("chrome/browser/resources/BUILD.gn", (source) =>
    replaceOnce(
      source,
      '    inputs = [\n      "glic/extension/manifest.json",',
      "    inputs = [\n" +
        assetNames.map((name) => `      "eliza_browser/${name}",\n`).join("") +
        '      "glic/extension/manifest.json",',
      "GRIT build inputs",
    ),
  );
  edit(`${prefix}component_extensions_allowlist/allowlist.cc`, (source) => {
    source = replaceOnce(
      source,
      "bool IsComponentExtensionAllowlisted(const std::string& extension_id) {\n  constexpr auto kAllowed = base::MakeFixedFlatSet<std::string_view>({\n",
      `bool IsComponentExtensionAllowlisted(const std::string& extension_id) {\n  constexpr auto kAllowed = base::MakeFixedFlatSet<std::string_view>({\n      "${EXTENSION_ID}",\n`,
      "component identity allowlist",
    );
    return replaceOnce(
      source,
      "  switch (manifest_resource_id) {\n",
      "  switch (manifest_resource_id) {\n    case IDR_ELIZA_BROWSER_MANIFEST:\n",
      "component resource allowlist",
    );
  });
  edit(`${prefix}component_loader.cc`, (source) => {
    source = insertInclude(source, verifier);
    return replaceOnce(
      source,
      "  if (should_disable_background_extensions) {\n    return;\n  }\n",
      "  if (should_disable_background_extensions) {\n    return;\n  }\n\n" +
        "  if (!skip_session_components && !profile_->IsOffTheRecord()) {\n" +
        "    if (eliza_component::VerifyBundle()) {\n" +
        '      Add(IDR_ELIZA_BROWSER_MANIFEST, base::FilePath(FILE_PATH_LITERAL("eliza_browser")));\n' +
        '    } else {\n      LOG(ERROR) << "Eliza component resource integrity verification failed";\n    }\n  }\n',
      "regular-profile component startup",
    );
  });
  edit(
    `${prefix}api/messaging/android/native_message_android_port.cc`,
    (source) => {
      source = insertInclude(source, verifier);
      return replaceOnce(
        source,
        "  bool is_verified = delegate.GetVerifierSourceType(*extension) !=\n                     ContentVerifierDelegate::VerifierSourceType::NONE;",
        "  bool is_verified = delegate.GetVerifierSourceType(*extension) !=\n                     ContentVerifierDelegate::VerifierSourceType::NONE ||\n                     eliza_component::VerifyExtension(*extension);",
        "verified native admission",
      );
    },
  );
  edit("extensions/browser/api/messaging/message_service.cc", (source) =>
    replaceOnce(
      source,
      "constexpr auto kAndroidNativeMessagingAllowedExtensionIds =\n    base::MakeFixedFlatSet<std::string_view>({\n",
      `constexpr auto kAndroidNativeMessagingAllowedExtensionIds =\n    base::MakeFixedFlatSet<std::string_view>({\n        "${EXTENSION_ID}",\n`,
      "native messaging identity allowlist",
    ),
  );
  edit(`${prefix}chrome_extensions_browser_client.cc`, (source) => {
    source = insertInclude(
      insertInclude(source, integrity),
      "services/network/public/cpp/resource_request.h",
    );
    return replaceOnce(
      source,
      "  return chrome_url_request_util::GetBundleResourcePath(\n      request, extension_resources_path, resource_id);",
      "  auto bundled = chrome_url_request_util::GetBundleResourcePath(\n      request, extension_resources_path, resource_id);\n" +
        "  if (request.url.GetHost() == extensions::eliza_component::kExtensionId && bundled.empty()) {\n" +
        "    // Force the bundle loader to reject unknown resources; never fall back to disk.\n" +
        '    *resource_id = 0;\n    return base::FilePath(FILE_PATH_LITERAL("eliza_browser/rejected"));\n  }\n  return bundled;',
      "deny filesystem fallback",
    );
  });
  edit(`${prefix}chrome_url_request_util.cc`, (source) => {
    source = insertInclude(
      insertInclude(source, verifier),
      "extensions/browser/extension_registry.h",
    );
    source = replaceOnce(
      source,
      "  const ui::ResourceBundle& rb = ui::ResourceBundle::GetSharedInstance();",
      "  if (extension_id == extensions::eliza_component::kExtensionId) {\n" +
        "    const auto* extension = extensions::ExtensionRegistry::Get(browser_context)->enabled_extensions().GetByID(extension_id);\n" +
        "    if (!extension || !extensions::eliza_component::VerifyExtension(*extension)) return nullptr;\n" +
        "    auto verified = extensions::eliza_component::ReadVerifiedResource(resource_id);\n" +
        "    if (!verified) return nullptr;\n" +
        "    return base::MakeRefCounted<base::RefCountedString>(std::move(*verified));\n  }\n" +
        "  const ui::ResourceBundle& rb = ui::ResourceBundle::GetSharedInstance();",
      "serve the verified immutable copy",
    );
    return replaceOnce(
      source,
      "    auto data = GetResource(resource_id, extension_id, *read_mime_type,\n                            browser_context.get());",
      "    auto data = GetResource(resource_id, extension_id, *read_mime_type,\n                            browser_context.get());\n" +
        "    if (!data) {\n      client_->OnComplete(network::URLLoaderCompletionStatus(net::ERR_BLOCKED_BY_CLIENT));\n" +
        "      client_.reset();\n      MaybeDeleteSelf();\n      return;\n    }",
      "integrity failure receipt",
    );
  });
  edit(`${prefix}BUILD.gn`, (source) => {
    source = replaceOnce(
      source,
      '    "chrome_url_request_util.h",',
      '    "chrome_url_request_util.h",\n    "eliza_component_integrity.h",\n    "eliza_component_verifier.h",',
      "generated verifier headers",
    );
    source = replaceOnce(
      source,
      '      "//content/public/common",\n      "//crypto",\n      "//device/bluetooth",',
      '      "//content/public/common",\n      "//device/bluetooth",',
      "move hash dependency out of desktop-only block",
    );
    return replaceOnce(
      source,
      '  deps = [\n    "//base",\n    "//chrome/app:command_ids",',
      '  deps = [\n    "//base",\n    "//crypto",\n    "//chrome/app:command_ids",',
      "Android verifier hash dependency",
    );
  });
  applyIndexedDBLockOrder(edit, replaceOnce);
  if (platform === "android") {
    applyStandaloneCredMan(edit, replaceOnce);
    applyStandaloneCredManTests(edit, replaceOnce);
  }
  return {
    files,
    report: {
      chromiumRevision: pin.revision,
      extensionId: EXTENSION_ID,
      platform,
      resources: Object.fromEntries(
        assetNames.map((name) => [
          name,
          { bytes: assets[name].length, sha256: sha256(assets[name]) },
        ]),
      ),
      inputs: pin.sha256,
      outputs: Object.fromEntries(
        Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)]),
      ),
      unrestrictedAllowlistBypass: false,
      releaseBrowserBuildValidated: false,
    },
  };
}

/** Produces an ordinary git-apply patch without mutating the caller's checkout. */
export async function createComponentPatch(sources, files) {
  const root = await mkdtemp(path.join(tmpdir(), "eliza-chromium-patch-"));
  try {
    for (const side of ["before", "after"]) await mkdir(path.join(root, side));
    for (const [filename, contents] of Object.entries(files)) {
      if (
        path.isAbsolute(filename) ||
        filename
          .split(/[\\/]/)
          .some((part) => part === ".." || part === "." || part === "")
      )
        throw new Error("Invalid component overlay path");
      for (const [side, bytes] of [
        ["before", sources[filename]],
        ["after", contents],
      ]) {
        if (bytes === undefined) continue;
        const target = path.join(root, side, filename);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
    }
    let patch;
    try {
      patch = execFileSync(
        "git",
        [
          "diff",
          "--no-index",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--binary",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--",
          "before",
          "after",
        ],
        { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (error) {
      if (error.status !== 1 || typeof error.stdout !== "string") throw error;
      patch = error.stdout;
    }
    return patch
      .split("\n")
      .map((line) => {
        if (
          line.startsWith("diff --git ") ||
          line.startsWith("--- ") ||
          line.startsWith("+++ ")
        )
          return line
            .replaceAll("a/before/", "a/")
            .replaceAll("a/after/", "a/")
            .replaceAll("b/before/", "b/")
            .replaceAll("b/after/", "b/");
        return line;
      })
      .join("\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** OS integration must recheck these bytes immediately before applying its patch. */
export async function readReviewedChromiumSources(sourceRoot) {
  const revision = execFileSync(
    "git",
    ["-C", sourceRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  if (revision !== pin.revision)
    throw new Error(
      "Chromium HEAD does not match the pinned component revision",
    );
  const sources = Object.fromEntries(
    await Promise.all(
      Object.entries(pin.sha256).map(async ([filename, hash]) => {
        const bytes = await readFile(path.join(sourceRoot, filename), "utf8");
        if (sha256(bytes) !== hash)
          throw new Error(`Chromium source integrity mismatch: ${filename}`);
        return [filename, bytes];
      }),
    ),
  );
  return { sources, revision };
}

async function main(args) {
  const option = (name) => args[args.indexOf(name) + 1];
  for (const name of ["--source", "--extension", "--out", "--platform"])
    if (!args.includes(name)) throw new Error(`Missing ${name}`);
  const sourceRoot = path.resolve(option("--source"));
  const extensionRoot = path.resolve(option("--extension"));
  const outputRoot = path.resolve(option("--out"));
  const { sources, revision } = await readReviewedChromiumSources(sourceRoot);
  const assets = Object.fromEntries(
    await Promise.all(
      (await readdir(extensionRoot)).map(async (name) => [
        name,
        await readFile(path.join(extensionRoot, name)),
      ]),
    ),
  );
  const overlay = await generateComponentOverlay({
    sources,
    assets,
    revision,
    platform: option("--platform"),
    certificate: args.includes("--certificate")
      ? option("--certificate")
      : undefined,
  });
  // A fresh output directory prevents accidental replacement of a checkout or unrelated artifacts.
  await mkdir(outputRoot, { recursive: false });
  for (const [name, bytes] of Object.entries(overlay.files)) {
    const filename = path.join(outputRoot, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes, { flag: "wx" });
  }
  const patch = await createComponentPatch(sources, overlay.files);
  overlay.report.patchSha256 = sha256(patch);
  await writeFile(path.join(outputRoot, "eliza-component.patch"), patch, {
    flag: "wx",
  });
  await writeFile(
    path.join(outputRoot, "eliza-component-overlay.json"),
    `${JSON.stringify(overlay.report, null, 2)}\n`,
    { flag: "wx" },
  );
  process.stdout.write(`${JSON.stringify(overlay.report, null, 2)}\n`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main(process.argv.slice(2));
