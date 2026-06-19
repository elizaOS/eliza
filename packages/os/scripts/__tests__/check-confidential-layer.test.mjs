// GAP 3: meta-elizaos Yocto layer validation tests (OS-1).
// Runner: node --test (bun test segfaults on the OS lane in this environment).
//   node --test packages/os/scripts/__tests__/check-confidential-layer.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  checkConfidentialLayer,
  checkLayerConf,
  extractFileUris,
  LAYER_DIR,
} from "../check-confidential-layer.mjs";

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

test("the real recipe references only files that exist (no larp)", async () => {
  const recipe = await readFile(
    path.join(
      LAYER_DIR,
      "recipes-elizaos/elizaos-confidential-profile/elizaos-confidential-profile.bb",
    ),
    "utf8",
  );
  const uris = extractFileUris(recipe);
  // The recipe must install the policy + the GAP-2 artifacts.
  assert.ok(uris.includes("policy/confidential-policy.json"));
  assert.ok(uris.includes("cmdline.conf"));
  assert.ok(uris.includes("sysctl.d/99-confidential.conf"));
  assert.ok(uris.includes("masked-units.txt"));
});
