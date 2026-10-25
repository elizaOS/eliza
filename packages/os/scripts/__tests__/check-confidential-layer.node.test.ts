import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkConfidentialLayer,
  checkLayerConf,
  extractFileUris,
  LAYER_DIR,
} from "../check-confidential-layer.ts";

test("shipped meta-elizaos layer passes the gate", async () => {
  const result = await checkConfidentialLayer();
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("shipped layer.conf declares every required directive", async () => {
  const conf = await readFile(path.join(LAYER_DIR, "conf/layer.conf"), "utf8");
  assert.deepEqual(checkLayerConf(conf), []);
});

test("a layer.conf missing BBFILE_COLLECTIONS is rejected", () => {
  const conf = [
    'BBPATH .= ":${LAYERDIR}"',
    'BBFILES += "${LAYERDIR}/recipes-*/*/*.bb"',
    'BBFILE_PATTERN_meta-elizaos = "^${LAYERDIR}/"',
    'BBFILE_PRIORITY_meta-elizaos = "10"',
    'LAYERSERIES_COMPAT_meta-elizaos = "scarthgap"',
    'LAYERDEPENDS_meta-elizaos = "core"',
  ].join("\n");
  const errors = checkLayerConf(conf);
  assert.ok(errors.some((e) => e.includes("BBFILE_COLLECTIONS")));
});

test("a layer.conf missing LAYERSERIES_COMPAT is rejected", () => {
  const conf = [
    'BBFILES += "${LAYERDIR}/recipes-*/*/*.bb"',
    'BBFILE_COLLECTIONS += "meta-elizaos"',
    'BBFILE_PATTERN_meta-elizaos = "^${LAYERDIR}/"',
    'BBFILE_PRIORITY_meta-elizaos = "10"',
    'LAYERDEPENDS_meta-elizaos = "core"',
  ].join("\n");
  const errors = checkLayerConf(conf);
  assert.ok(errors.some((e) => e.includes("LAYERSERIES_COMPAT")));
});

test("extractFileUris reads only literal SRC_URI sources, skipping variables", () => {
  const recipe = [
    'LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=abc"',
    'SRC_URI = "\\',
    "    file://policy/confidential-policy.json \\",
    "    file://cmdline.conf \\",
    '"',
  ].join("\n");
  const uris = extractFileUris(recipe);
  assert.deepEqual(uris, ["policy/confidential-policy.json", "cmdline.conf"]);
});

test("recipe references the required local policy inputs", async () => {
  const recipe = await readFile(
    path.join(
      LAYER_DIR,
      "recipes-elizaos/elizaos-confidential-profile/elizaos-confidential-profile.bb",
    ),
    "utf8",
  );
  const uris = extractFileUris(recipe);
  // Required boot policy inputs.
  assert.ok(uris.includes("policy/confidential-policy.json"));
  assert.ok(uris.includes("cmdline.conf"));
  assert.ok(uris.includes("sysctl.d/99-confidential.conf"));
  assert.ok(uris.includes("masked-units.txt"));
});

test("recipe stages example measurements only as documentation", async (t) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "eliza-yocto-install-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const recipe = await readFile(
    path.join(
      LAYER_DIR,
      "recipes-elizaos/elizaos-confidential-profile/elizaos-confidential-profile.bb",
    ),
    "utf8",
  );
  const body = recipe.match(/^do_install\(\) \{\n([\s\S]*?)^\}/m)?.[1];
  assert.ok(body, "recipe must contain an install task");
  const work = path.join(temporary, "work");
  for (const input of extractFileUris(recipe)) {
    const destination = path.join(work, input);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(path.dirname(LAYER_DIR), input), destination);
  }
  const destination = path.join(temporary, "root");
  const installed = spawnSync("bash", ["-eu"], {
    input: body,
    encoding: "utf8",
    env: {
      ...process.env,
      D: destination,
      WORKDIR: work,
      sysconfdir: "/etc",
      docdir: "/usr/share/doc",
      PN: "elizaos-confidential-profile",
    },
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(
    existsSync(path.join(destination, "etc/elizaos/tee/image-manifest.json")),
    false,
  );
  assert.deepEqual(
    await readFile(
      path.join(
        destination,
        "usr/share/doc/elizaos-confidential-profile/image-manifest.example.json",
      ),
    ),
    await readFile(path.join(work, "image-manifest.example.json")),
  );
  assert.deepEqual(
    await readFile(
      path.join(destination, "etc/elizaos/tee/confidential-policy.json"),
    ),
    await readFile(path.join(work, "policy/confidential-policy.json")),
  );
});
