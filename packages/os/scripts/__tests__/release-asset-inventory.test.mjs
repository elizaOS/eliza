/**
 * Exercises the exact release-asset snapshot, downloaded-byte verification,
 * drift rejection, and evidence-complete recovery PR renderer on real files.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  evaluatePrEvidence,
  REQUIRED_EVIDENCE_ROWS,
} from "../../../../scripts/check-pr-evidence.mjs";
import {
  assertReleaseAssetInventoriesEqual,
  createReleaseAssetInventory,
  releaseAssetInventorySha256,
  renderReleaseAssetReceiptMarkdown,
  verifyDownloadedReleaseAssets,
} from "../release-asset-inventory.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);
const scriptPath = path.join(
  repoRoot,
  "packages/os/scripts/release-asset-inventory.mjs",
);
const evidenceCheckerPath = path.join(
  repoRoot,
  "scripts/check-pr-evidence.mjs",
);

function sha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function releaseResponse() {
  return {
    id: 7001,
    node_id: "RE_kwDO_exact_release",
    tag_name: "v2.0.4-os.1",
    target_commitish: "develop",
    draft: false,
    prerelease: true,
    published_at: "2026-07-13T20:00:00Z",
    immutable: false,
  };
}

function assetResponse(id, name, payload, overrides = {}) {
  return {
    id,
    node_id: `RA_kwDO_asset_${id}`,
    name,
    size: Buffer.byteLength(payload),
    digest: `sha256:${sha256(payload)}`,
    state: "uploaded",
    created_at: "2026-07-13T20:01:00Z",
    updated_at: "2026-07-13T20:01:01Z",
    ...overrides,
  };
}

function inventoryFixture() {
  const payloads = new Map([
    ["elizaos-live-amd64.img.zst", "real compressed image bytes\n"],
    ["elizaos-vm-amd64.ova", "real virtual machine bytes\n"],
  ]);
  const assets = [
    assetResponse(
      9002,
      "elizaos-vm-amd64.ova",
      payloads.get("elizaos-vm-amd64.ova"),
    ),
    assetResponse(
      9001,
      "elizaos-live-amd64.img.zst",
      payloads.get("elizaos-live-amd64.img.zst"),
    ),
  ];
  const inventory = createReleaseAssetInventory({
    repository: "elizaOS/eliza",
    release: releaseResponse(),
    assets: [[assets[0]], [assets[1]]],
  });
  return { assets, inventory, payloads };
}

async function materializeArtifacts(directory, payloads) {
  await mkdir(directory, { recursive: true });
  for (const [name, payload] of payloads) {
    await writeFile(path.join(directory, name), payload);
  }
}

test("canonical inventory binds stable IDs, names, sizes, and available digests", () => {
  const { inventory } = inventoryFixture();

  assert.deepEqual(
    inventory.assets.map((asset) => asset.databaseId),
    [9001, 9002],
  );
  assert.equal(inventory.release.databaseId, 7001);
  assert.equal(inventory.release.nodeId, "RE_kwDO_exact_release");
  assert.ok(
    inventory.assets.every((asset) =>
      /^sha256:[a-f0-9]{64}$/.test(asset.githubDigest),
    ),
  );
  assert.match(releaseAssetInventorySha256(inventory), /^[a-f0-9]{64}$/);
});

test("inventory capture rejects unsafe, duplicate, empty, and malformed assets", () => {
  const release = releaseResponse();
  const valid = assetResponse(9001, "image.img.zst", "payload");

  assert.throws(
    () =>
      createReleaseAssetInventory({
        repository: "elizaOS/eliza",
        release,
        assets: [{ ...valid, name: "../image.img.zst" }],
      }),
    /safe single filename/,
  );
  assert.throws(
    () =>
      createReleaseAssetInventory({
        repository: "elizaOS/eliza",
        release,
        assets: [valid, { ...valid, node_id: "different-node" }],
      }),
    /duplicate 9001/,
  );
  assert.throws(
    () =>
      createReleaseAssetInventory({
        repository: "elizaOS/eliza",
        release,
        assets: [],
      }),
    /at least one/,
  );
  assert.throws(
    () =>
      createReleaseAssetInventory({
        repository: "elizaOS/eliza",
        release,
        assets: [{ ...valid, digest: "sha512:not-authoritative" }],
      }),
    /sha256/,
  );
});

test("download verification proves the exact real filename, size, and byte set", async () => {
  const { inventory, payloads } = inventoryFixture();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-asset-exact-"));
  await materializeArtifacts(tmp, payloads);

  const receipt = await verifyDownloadedReleaseAssets(inventory, tmp);
  assert.equal(receipt.assets.length, inventory.assets.length);
  for (const asset of receipt.assets) {
    assert.equal(
      `sha256:${asset.downloadedSha256}`,
      asset.githubDigest,
      asset.name,
    );
  }
  const markdown = await renderReleaseAssetReceiptMarkdown(inventory, receipt);
  assert.match(markdown, /Asset database ID/);
  assert.match(markdown, /9001/);
  assert.match(markdown, /elizaos-live-amd64\.img\.zst/);
  assert.match(markdown, new RegExp(receipt.inventorySha256));
});

test("download verification rejects an extra filename", async () => {
  const { inventory, payloads } = inventoryFixture();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-asset-extra-"));
  await materializeArtifacts(tmp, payloads);
  await writeFile(path.join(tmp, "unexpected.sig"), "extra");
  await assert.rejects(
    verifyDownloadedReleaseAssets(inventory, tmp),
    /unexpected=unexpected\.sig/,
  );
});

test("download verification rejects a missing filename", async () => {
  const { inventory, payloads } = inventoryFixture();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-asset-missing-"));
  await mkdir(tmp, { recursive: true });
  const [first] = payloads;
  await writeFile(path.join(tmp, first[0]), first[1]);
  await assert.rejects(
    verifyDownloadedReleaseAssets(inventory, tmp),
    /missing=elizaos-vm-amd64\.ova/,
  );
});

test("download verification rejects a non-file entry", async () => {
  const { inventory, payloads } = inventoryFixture();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-asset-nonfile-"));
  await materializeArtifacts(tmp, payloads);
  await mkdir(path.join(tmp, "nested"));
  await assert.rejects(
    verifyDownloadedReleaseAssets(inventory, tmp),
    /non-file entries: nested/,
  );
});

test("download verification rejects a size mismatch", async () => {
  const { inventory, payloads } = inventoryFixture();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-asset-size-"));
  await materializeArtifacts(tmp, payloads);
  await writeFile(path.join(tmp, "elizaos-vm-amd64.ova"), "short");
  await assert.rejects(
    verifyDownloadedReleaseAssets(inventory, tmp),
    /downloaded size .* differs from captured size/,
  );
});

test("download verification rejects a same-size digest replacement", async () => {
  const expectedPayload = "right";
  const replacementPayload = "wrong";
  assert.equal(expectedPayload.length, replacementPayload.length);
  const replacementInventory = createReleaseAssetInventory({
    repository: "elizaOS/eliza",
    release: releaseResponse(),
    assets: [assetResponse(9010, "same-size.img", expectedPayload)],
  });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-asset-digest-"));
  await writeFile(path.join(tmp, "same-size.img"), replacementPayload);
  await assert.rejects(
    verifyDownloadedReleaseAssets(replacementInventory, tmp),
    /downloaded SHA-256 .* differs from GitHub/,
  );
});

test("post-download comparison rejects extras, replacements, and field drift", () => {
  const { inventory } = inventoryFixture();
  assert.deepEqual(
    assertReleaseAssetInventoriesEqual(inventory, structuredClone(inventory)),
    inventory,
  );

  const extra = structuredClone(inventory);
  extra.assets.push({
    ...extra.assets[0],
    databaseId: 9999,
    nodeId: "RA_kwDO_asset_9999",
    name: "unexpected.img",
  });
  assert.throws(
    () => assertReleaseAssetInventoriesEqual(inventory, extra),
    /added asset IDs: 9999/,
  );

  const replacement = structuredClone(inventory);
  replacement.assets[0] = {
    ...replacement.assets[0],
    databaseId: 9998,
    nodeId: "RA_kwDO_asset_9998",
  };
  replacement.assets.sort((left, right) => left.databaseId - right.databaseId);
  assert.throws(
    () => assertReleaseAssetInventoriesEqual(inventory, replacement),
    /removed asset IDs: 9001; added asset IDs: 9998/,
  );

  const changed = structuredClone(inventory);
  changed.assets[0].sizeBytes += 1;
  assert.throws(
    () => assertReleaseAssetInventoriesEqual(inventory, changed),
    /changed asset IDs: 9001/,
  );
});

test("the workflow CLI renders a draft-ready body that passes the real evidence gate", async () => {
  const { assets, payloads } = inventoryFixture();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "os-asset-cli-"));
  const releasePath = path.join(tmp, "release.json");
  const assetsPath = path.join(tmp, "assets.json");
  const preInventoryPath = path.join(tmp, "inventory-pre.json");
  const postInventoryPath = path.join(tmp, "inventory-post.json");
  const artifactRoot = path.join(tmp, "downloads");
  const receiptPath = path.join(tmp, "download-receipt.json");
  const markdownPath = path.join(tmp, "asset-receipt.md");
  const logPath = path.join(tmp, "recovery.log");
  const bodyPath = path.join(tmp, "pull-request.md");
  await writeFile(releasePath, `${JSON.stringify(releaseResponse())}\n`);
  await writeFile(
    assetsPath,
    `${JSON.stringify([[assets[0]], [assets[1]]])}\n`,
  );

  for (const output of [preInventoryPath, postInventoryPath]) {
    await execFileAsync(
      process.execPath,
      [
        scriptPath,
        "capture",
        "--repository",
        "elizaOS/eliza",
        "--release",
        releasePath,
        "--assets",
        assetsPath,
        "--output",
        output,
      ],
      { cwd: repoRoot },
    );
  }

  const plan = await execFileAsync(
    process.execPath,
    [scriptPath, "plan", "--inventory", preInventoryPath],
    { cwd: repoRoot },
  );
  assert.equal(
    plan.stdout,
    "9001\telizaos-live-amd64.img.zst\n9002\telizaos-vm-amd64.ova\n",
  );

  await materializeArtifacts(artifactRoot, payloads);
  await execFileAsync(
    process.execPath,
    [
      scriptPath,
      "verify",
      "--inventory",
      preInventoryPath,
      "--artifact-root",
      artifactRoot,
      "--receipt",
      receiptPath,
      "--markdown",
      markdownPath,
    ],
    { cwd: repoRoot },
  );
  await execFileAsync(
    process.execPath,
    [
      scriptPath,
      "compare",
      "--expected",
      preInventoryPath,
      "--observed",
      postInventoryPath,
    ],
    { cwd: repoRoot },
  );

  await writeFile(
    logPath,
    "captured exact release and asset IDs\ndownloaded each asset by database ID\nverified post-download inventory\n",
  );
  await execFileAsync(
    process.execPath,
    [
      scriptPath,
      "render-pr",
      "--inventory",
      preInventoryPath,
      "--receipt",
      receiptPath,
      "--base-sha",
      "a".repeat(40),
      "--tag-sha",
      "b".repeat(40),
      "--tag",
      releaseResponse().tag_name,
      "--manifest",
      "packages/os/release/test/manifest.json",
      "--run-url",
      "https://github.com/elizaOS/eliza/actions/runs/12345/attempts/2",
      "--log",
      logPath,
      "--output",
      bodyPath,
    ],
    { cwd: repoRoot },
  );

  const body = await readFile(bodyPath, "utf8");
  const gate = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
    changedFiles: ["packages/os/release/test/manifest.json"],
  });
  assert.equal(gate.ok, true, JSON.stringify(gate.findings));
  for (const { id } of REQUIRED_EVIDENCE_ROWS) {
    assert.match(body, new RegExp(`evidence-row:${id}`));
  }
  assert.match(body, /Exact base SHA: `a{40}`/);
  assert.match(body, /Exact tag commit SHA: `b{40}`/);
  assert.match(body, /Asset database ID/);
  assert.match(body, /downloaded each asset by database ID/);
  await execFileAsync(
    process.execPath,
    [evidenceCheckerPath, "--body-file", bodyPath],
    { cwd: repoRoot },
  );
});
