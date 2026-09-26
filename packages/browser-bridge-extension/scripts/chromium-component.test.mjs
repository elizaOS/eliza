/** Tests pinned upstream transformations and executes the actual generated C++ integrity predicate. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assetNames,
  createComponentPatch,
  EXTENSION_ID,
  generateComponentOverlay,
  pin,
  sha256,
} from "./chromium-component.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const identity = JSON.parse(
  await readFile(path.join(here, "../identity.json"), "utf8"),
);
const sources = Object.fromEntries(
  await Promise.all(
    Object.keys(pin.sha256).map(async (name) => [
      name,
      await readFile(path.join(here, "chromium/fixtures", name), "utf8"),
    ]),
  ),
);
const certificate = "A".repeat(64);
function assets() {
  return {
    "background.mjs": Buffer.from('import "./commands.mjs";\n'),
    "commands.mjs": Buffer.from('export const context = "完整🙂";\n'),
    "native-connection.mjs": Buffer.from("export const recovery = true;\n"),
    "protocol.mjs": Buffer.from("export const protocol = 2;\n"),
    "runtime-config.mjs": Buffer.from(
      `export const nativeHost = ${JSON.stringify({ application: "ai.elizaos.app", androidCertificates: [certificate] })};\n`,
    ),
    "manifest.json": Buffer.from(
      JSON.stringify({
        manifest_version: 3,
        name: "Eliza Browser Control",
        version: "2.0.4",
        key: identity.chromeDevManifestKey,
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
      }),
    ),
  };
}
const request = () => ({
  sources,
  assets: assets(),
  revision: pin.revision,
  platform: "android",
  certificate,
});

test("pinned Chromium sources produce deterministic component and narrow native verification changes", async () => {
  const first = await generateComponentOverlay(request());
  const second = await generateComponentOverlay(request());
  assert.deepEqual(first, second);
  assert.equal(first.report.releaseBrowserBuildValidated, false);
  assert.equal(first.report.unrestrictedAllowlistBypass, false);
  assert.equal(first.report.extensionId, EXTENSION_ID);
  const prefix = "chrome/browser/extensions/";
  assert.match(
    first.files[`${prefix}component_loader.cc`],
    /!profile_->IsOffTheRecord\(\)/,
  );
  assert.match(
    first.files[`${prefix}chrome_extensions_browser_client.cc`],
    /bundled.empty\(\)[\s\S]*resource_id = 0/,
  );
  assert.match(
    first.files[`${prefix}chrome_extensions_browser_client.cc`],
    /#include "services\/network\/public\/cpp\/resource_request\.h"/,
  );
  assert.match(
    first.files[`${prefix}chrome_url_request_util.cc`],
    /ReadVerifiedResource\(resource_id\)/,
  );
  assert.match(
    first.files[`${prefix}chrome_url_request_util.cc`],
    /ERR_BLOCKED_BY_CLIENT/,
  );
  assert.match(
    first.files[
      `${prefix}api/messaging/android/native_message_android_port.cc`
    ],
    /GetVerifierSourceType\(\*extension\)[\s\S]*eliza_component::VerifyExtension\(\*extension\)/,
  );
  assert.equal(
    first.files["extensions/common/extension_features.cc"],
    undefined,
  );
  assert.equal(
    first.files[`${prefix}chrome_content_verifier_delegate.cc`],
    undefined,
  );
  for (const name of assetNames)
    assert.equal(
      sha256(first.files[`chrome/browser/resources/eliza_browser/${name}`]),
      first.report.resources[name].sha256,
    );
});

test("both owned platforms serialize each Blink generator action without changing its inputs or outputs", async () => {
  const filename = "third_party/blink/renderer/bindings/BUILD.gn";
  for (const platform of ["android", "linux"]) {
    const input = request();
    input.platform = platform;
    if (platform === "linux") {
      input.assets["runtime-config.mjs"] = Buffer.from(
        'export const nativeHost = "ai.elizaos.browser";\n',
      );
    }
    const overlay = await generateComponentOverlay(input);
    const transformed = overlay.files[filename];
    const template = transformed.slice(
      transformed.indexOf('template("generate_bindings")'),
      transformed.indexOf("# Per-type bindings generation actions."),
    );
    assert.match(template, /script = "scripts\/generate_bindings\.py"/);
    assert.match(template, /args = \[\s*"--single_process",/);
    assert.equal(transformed.split('"--single_process"').length, 2);
    assert.equal(
      transformed.replace('      "--single_process",\n', ""),
      sources[filename],
    );
    assert.equal(overlay.report.outputs[filename], sha256(transformed));
  }
});

test("both platforms emit the reviewed order-independent IndexedDB fix and native regressions", async () => {
  const expected = {
    "content/browser/indexed_db/instance/connection.cc":
      "ec5f8dc64b4f77cd1b99157caf22a6f113e6c2290bb6c3abe4e23cf7517d9c5a",
    "content/browser/indexed_db/instance/transaction_unittest.cc":
      "c599805c5d7d43c664f97157f66ac656cc0c4a4dac872df147eef0e16264cbfb",
  };
  for (const platform of ["android", "linux"]) {
    const input = request();
    input.platform = platform;
    if (platform === "linux") {
      input.assets["runtime-config.mjs"] = Buffer.from(
        'export const nativeHost = "ai.elizaos.browser";\n',
      );
    }
    const first = await generateComponentOverlay(input);
    const second = await generateComponentOverlay(input);
    assert.deepEqual(first, second);
    for (const [filename, hash] of Object.entries(expected)) {
      assert.equal(sha256(first.files[filename]), hash);
      assert.equal(first.report.outputs[filename], hash);
    }
    const connection = first.files[Object.keys(expected)[0]];
    assert.doesNotMatch(connection, /STLSetIntersection/);
    assert.match(connection, /held_lock_ids.contains\(id\)/);
  }
});

test("source mutations, unsupported revisions, identity changes, and unexpected resources fail before output", async () => {
  await assert.rejects(
    generateComponentOverlay({ ...request(), revision: "0".repeat(40) }),
    /Unsupported Chromium revision/,
  );
  for (const name of Object.keys(sources))
    await assert.rejects(
      generateComponentOverlay({
        ...request(),
        sources: { ...sources, [name]: `${sources[name]}\n// changed` },
      }),
      /source integrity mismatch/,
    );
  const unexpected = assets();
  unexpected["unreviewed.mjs"] = Buffer.from("code");
  await assert.rejects(
    generateComponentOverlay({ ...request(), assets: unexpected }),
    /inventory changed/,
  );
  const wrongKey = assets();
  const manifest = JSON.parse(wrongKey["manifest.json"]);
  manifest.key = Buffer.from("different public key").toString("base64");
  wrongKey["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  await assert.rejects(
    generateComponentOverlay({ ...request(), assets: wrongKey }),
    /identity or reviewed/,
  );
  await assert.rejects(
    generateComponentOverlay({ ...request(), certificate: "B".repeat(64) }),
    /host configuration/,
  );
  const extended = assets();
  const more = JSON.parse(extended["manifest.json"]);
  more.externally_connectable = { matches: ["https://*/*"] };
  extended["manifest.json"] = Buffer.from(JSON.stringify(more));
  await assert.rejects(
    generateComponentOverlay({ ...request(), assets: extended }),
    /identity or reviewed/,
  );
});

test("generated C++ rejects corrupted, missing, truncated, unknown, and wrong-identity component resources", async () => {
  const fixture = assets();
  const overlay = await generateComponentOverlay({
    ...request(),
    assets: fixture,
  });
  const root = await mkdtemp(path.join(tmpdir(), "eliza-component-integrity-"));
  try {
    await writeFile(
      path.join(root, "integrity.h"),
      overlay.files["chrome/browser/extensions/eliza_component_integrity.h"],
    );
    for (const [name, bytes] of Object.entries(fixture))
      await writeFile(path.join(root, name), bytes);
    await writeFile(
      path.join(root, "test.cc"),
      `
#include "integrity.h"
#include <cassert>
#include <fstream>
#include <iterator>
#include <openssl/sha.h>
using namespace extensions::eliza_component;
std::string Hash(std::string_view bytes) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(bytes.data()), bytes.size(), digest);
  const char* hex = "0123456789abcdef"; std::string result;
  for (auto byte : digest) { result += hex[byte >> 4]; result += hex[byte & 15]; }
  return result;
}
std::optional<std::string> Read(std::string_view path) {
  std::ifstream input(std::string(path), std::ios::binary);
  if (!input) return std::nullopt;
  return std::string(std::istreambuf_iterator<char>(input), {});
}
int main() {
  assert(AuthorizedMetadata(kExtensionId, true, true, true));
  assert(!AuthorizedMetadata("unrelated", true, true, true));
  assert(!AuthorizedMetadata(kExtensionId, false, true, true));
  assert(!AuthorizedMetadata(kExtensionId, true, false, true));
  assert(!AuthorizedMetadata(kExtensionId, true, true, false));
  assert(VerifyResources(Read, Hash));
  for (const auto& resource : kResources) {
    auto bytes = *Read(resource.path);
    assert(VerifyResource(resource.path, bytes, Hash));
    bytes[0] ^= 1;
    assert(!VerifyResource(resource.path, bytes, Hash));
    auto changed = [&](std::string_view path) -> std::optional<std::string> {
      return path == resource.path ? std::optional<std::string>(bytes) : Read(path);
    };
    assert(!VerifyResources(changed, Hash));
    auto missing = [&](std::string_view path) -> std::optional<std::string> {
      return path == resource.path ? std::nullopt : Read(path);
    };
    assert(!VerifyResources(missing, Hash));
    bytes.pop_back();
    assert(!VerifyResource(resource.path, bytes, Hash));
  }
  assert(!VerifyResource("../background.mjs", *Read("background.mjs"), Hash));
  assert(!VerifyResource("unreviewed.mjs", *Read("background.mjs"), Hash));
}
`,
    );
    execFileSync(
      process.env.CXX || "c++",
      [
        "-std=c++20",
        "-Wall",
        "-Wextra",
        "-Werror",
        "test.cc",
        "-lcrypto",
        "-o",
        "integrity-test",
      ],
      { cwd: root, stdio: "pipe" },
    );
    execFileSync(path.join(root, "integrity-test"), [], {
      cwd: root,
      stdio: "pipe",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated patch applies cleanly to pinned upstream and preserves every emitted byte", async () => {
  const overlay = await generateComponentOverlay(request());
  const patch = await createComponentPatch(sources, overlay.files);
  assert.equal(patch, await createComponentPatch(sources, overlay.files));
  const root = await mkdtemp(path.join(tmpdir(), "eliza-component-apply-"));
  try {
    for (const [filename, content] of Object.entries(sources)) {
      const target = path.join(root, filename);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    execFileSync("git", ["apply", "--check", "-"], {
      cwd: root,
      input: patch,
      stdio: "pipe",
    });
    execFileSync("git", ["apply", "-"], {
      cwd: root,
      input: patch,
      stdio: "pipe",
    });
    for (const [filename, hash] of Object.entries(overlay.report.outputs))
      assert.equal(sha256(await readFile(path.join(root, filename))), hash);
    assert.equal(
      await readFile(
        path.join(root, "extensions/common/extension_features.cc"),
        "utf8",
      ),
      sources["extensions/common/extension_features.cc"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await assert.rejects(
    createComponentPatch({}, { "../escape": "bad" }),
    /Invalid component overlay path/,
  );
});

test("Linux and Android resource additions fit the reviewed GRIT allocation", async () => {
  const overlay = await generateComponentOverlay(request());
  const includes = overlay.files[
    "chrome/browser/resources/component_extension_resources.grd"
  ]
    .split("<includes>")[1]
    .split("</includes>")[0]
    .replace(/<if expr="is_chromeos">[\s\S]*?<\/if>/g, "");
  const count = [...includes.matchAll(/<include\s/g)].length;
  const allocation = sources["tools/gritsettings/resource_ids.spec"].match(
    /"chrome\/browser\/resources\/component_extension_resources.grd":\s*\{\s*"includes": \[(\d+)\],\s*"structures": \[(\d+)\]/,
  );
  assert.ok(allocation);
  assert.ok(count <= Number(allocation[2]) - Number(allocation[1]));
  assert.equal(count, 17); // Includes both optional Hangouts entries, conservatively.
});
