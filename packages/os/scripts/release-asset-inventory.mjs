#!/usr/bin/env node
/**
 * Binds OS manifest recovery to one canonical GitHub release-asset snapshot.
 * The workflow uses the stable asset identities for ID-based downloads, then
 * proves the downloaded directory and post-download API state still match.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseArgs,
  readJson,
  sha256File,
  writeJson,
} from "./os-release-lib.mjs";

const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/;
const fullGitShaPattern = /^[a-f0-9]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const unsafeAssetNamePattern = /[\\/]/;
const maximumPullRequestBodyBytes = 60_000;

function fail(message) {
  throw new Error(message);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${field} must be a positive safe integer`);
  }
  return value;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") {
    fail(`${field} must be a boolean`);
  }
  return value;
}

function normalizeAssetPages(value) {
  if (!Array.isArray(value)) {
    fail("release assets response must be an array");
  }
  if (value.every((entry) => Array.isArray(entry))) {
    return value.flat();
  }
  if (value.every((entry) => entry && typeof entry === "object")) {
    return value;
  }
  fail(
    "release assets response must contain asset objects or paginated arrays",
  );
}

function normalizeGithubDigest(value, field) {
  if (value == null) return null;
  if (typeof value !== "string" || !sha256DigestPattern.test(value)) {
    fail(`${field} must be null or sha256:<64 lowercase hex>`);
  }
  return value;
}

function normalizeAssetName(value, field) {
  const name = requireNonEmptyString(value, field);
  const containsControlCharacter = [...name].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
  if (
    name !== name.trim() ||
    name === "." ||
    name === ".." ||
    unsafeAssetNamePattern.test(name) ||
    containsControlCharacter ||
    path.basename(name) !== name
  ) {
    fail(
      `${field} must be a safe single filename without surrounding whitespace`,
    );
  }
  return name;
}

function assertUnique(values, field) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`${field} contains duplicate ${String(value)}`);
    seen.add(value);
  }
}

/** Canonicalizes the release and every stable asset identity returned by GitHub. */
export function createReleaseAssetInventory({ repository, release, assets }) {
  if (typeof repository !== "string" || !repositoryPattern.test(repository)) {
    fail("repository must use owner/name form");
  }
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    fail("release response must be an object");
  }

  const draft = requireBoolean(release.draft, "release.draft");
  if (draft) fail("release must be published before manifest recovery");

  const normalizedAssets = normalizeAssetPages(assets).map((asset, index) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      fail(`assets[${index}] must be an object`);
    }
    if (asset.state !== "uploaded") {
      fail(`assets[${index}].state must be uploaded`);
    }
    return {
      databaseId: requirePositiveInteger(asset.id, `assets[${index}].id`),
      nodeId: requireNonEmptyString(asset.node_id, `assets[${index}].node_id`),
      name: normalizeAssetName(asset.name, `assets[${index}].name`),
      sizeBytes: requirePositiveInteger(asset.size, `assets[${index}].size`),
      githubDigest: normalizeGithubDigest(
        asset.digest,
        `assets[${index}].digest`,
      ),
      state: "uploaded",
      createdAt: requireNonEmptyString(
        asset.created_at,
        `assets[${index}].created_at`,
      ),
      updatedAt: requireNonEmptyString(
        asset.updated_at,
        `assets[${index}].updated_at`,
      ),
    };
  });

  if (normalizedAssets.length === 0) {
    fail("release must contain at least one non-empty uploaded asset");
  }
  assertUnique(
    normalizedAssets.map((asset) => asset.databaseId),
    "asset database IDs",
  );
  assertUnique(
    normalizedAssets.map((asset) => asset.nodeId),
    "asset node IDs",
  );
  assertUnique(
    normalizedAssets.map((asset) => asset.name),
    "asset names",
  );
  normalizedAssets.sort((left, right) => left.databaseId - right.databaseId);

  return {
    schemaVersion: 1,
    repository,
    release: {
      databaseId: requirePositiveInteger(release.id, "release.id"),
      nodeId: requireNonEmptyString(release.node_id, "release.node_id"),
      tagName: requireNonEmptyString(release.tag_name, "release.tag_name"),
      targetCommitish: requireNonEmptyString(
        release.target_commitish,
        "release.target_commitish",
      ),
      draft,
      prerelease: requireBoolean(release.prerelease, "release.prerelease"),
      publishedAt: requireNonEmptyString(
        release.published_at,
        "release.published_at",
      ),
      immutable: requireBoolean(release.immutable, "release.immutable"),
    },
    assets: normalizedAssets,
  };
}

function inventoryAsGithubResponses(inventory) {
  return {
    repository: inventory?.repository,
    release: {
      id: inventory?.release?.databaseId,
      node_id: inventory?.release?.nodeId,
      tag_name: inventory?.release?.tagName,
      target_commitish: inventory?.release?.targetCommitish,
      draft: inventory?.release?.draft,
      prerelease: inventory?.release?.prerelease,
      published_at: inventory?.release?.publishedAt,
      immutable: inventory?.release?.immutable,
    },
    assets: (inventory?.assets ?? []).map((asset) => ({
      id: asset.databaseId,
      node_id: asset.nodeId,
      name: asset.name,
      size: asset.sizeBytes,
      digest: asset.githubDigest,
      state: asset.state,
      created_at: asset.createdAt,
      updated_at: asset.updatedAt,
    })),
  };
}

/** Rejects non-canonical or augmented inventory files before they authorize work. */
export function validateStoredInventory(inventory) {
  if (inventory?.schemaVersion !== 1) {
    fail("release asset inventory schemaVersion must be 1");
  }
  const canonical = createReleaseAssetInventory(
    inventoryAsGithubResponses(inventory),
  );
  if (serializeJson(canonical) !== serializeJson(inventory)) {
    fail("release asset inventory is not in canonical form");
  }
  return canonical;
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Content digest used to cite the complete canonical inventory in reviews. */
export function releaseAssetInventorySha256(inventory) {
  const canonical = validateStoredInventory(inventory);
  return createHash("sha256").update(serializeJson(canonical)).digest("hex");
}

function inventoryDifferences(expected, observed) {
  const differences = [];
  if (JSON.stringify(expected.release) !== JSON.stringify(observed.release)) {
    differences.push("release identity changed");
  }

  const expectedById = new Map(
    expected.assets.map((asset) => [asset.databaseId, asset]),
  );
  const observedById = new Map(
    observed.assets.map((asset) => [asset.databaseId, asset]),
  );
  const removed = [...expectedById.keys()].filter(
    (id) => !observedById.has(id),
  );
  const added = [...observedById.keys()].filter((id) => !expectedById.has(id));
  const changed = [...expectedById.keys()].filter(
    (id) =>
      observedById.has(id) &&
      JSON.stringify(expectedById.get(id)) !==
        JSON.stringify(observedById.get(id)),
  );
  if (removed.length > 0)
    differences.push(`removed asset IDs: ${removed.join(", ")}`);
  if (added.length > 0)
    differences.push(`added asset IDs: ${added.join(", ")}`);
  if (changed.length > 0)
    differences.push(`changed asset IDs: ${changed.join(", ")}`);
  return differences;
}

/** Fails when assets were added, removed, replaced, renamed, or mutated. */
export function assertReleaseAssetInventoriesEqual(expected, observed) {
  const canonicalExpected = validateStoredInventory(expected);
  const canonicalObserved = validateStoredInventory(observed);
  const differences = inventoryDifferences(
    canonicalExpected,
    canonicalObserved,
  );
  if (differences.length > 0) {
    fail(`release asset inventory drifted: ${differences.join("; ")}`);
  }
  return canonicalExpected;
}

async function canonicalReceipt(inventory, receipt) {
  const canonicalInventory = validateStoredInventory(inventory);
  const expectedInventorySha256 =
    releaseAssetInventorySha256(canonicalInventory);
  if (receipt?.schemaVersion !== 1) {
    fail("download receipt schemaVersion must be 1");
  }
  if (receipt.inventorySha256 !== expectedInventorySha256) {
    fail("download receipt does not cite the canonical inventory digest");
  }
  if (!Array.isArray(receipt.assets)) {
    fail("download receipt assets must be an array");
  }
  const receiptById = new Map(
    receipt.assets.map((asset) => [asset?.databaseId, asset]),
  );
  const assets = canonicalInventory.assets.map((asset) => {
    const observed = receiptById.get(asset.databaseId);
    if (!observed)
      fail(`download receipt is missing asset ID ${asset.databaseId}`);
    const downloadedSha256 = requireNonEmptyString(
      observed.downloadedSha256,
      `download receipt ${asset.databaseId}.downloadedSha256`,
    );
    if (!/^[a-f0-9]{64}$/.test(downloadedSha256)) {
      fail(`download receipt ${asset.databaseId} has an invalid SHA-256`);
    }
    if (
      observed.nodeId !== asset.nodeId ||
      observed.name !== asset.name ||
      observed.sizeBytes !== asset.sizeBytes ||
      observed.githubDigest !== asset.githubDigest
    ) {
      fail(
        `download receipt identity differs for asset ID ${asset.databaseId}`,
      );
    }
    if (
      asset.githubDigest &&
      downloadedSha256 !== asset.githubDigest.slice("sha256:".length)
    ) {
      fail(`download receipt digest differs for asset ID ${asset.databaseId}`);
    }
    return {
      databaseId: asset.databaseId,
      nodeId: asset.nodeId,
      name: asset.name,
      sizeBytes: asset.sizeBytes,
      githubDigest: asset.githubDigest,
      downloadedSha256,
    };
  });
  if (receipt.assets.length !== assets.length) {
    fail("download receipt contains unexpected asset records");
  }
  const canonical = {
    schemaVersion: 1,
    inventorySha256: expectedInventorySha256,
    assets,
  };
  if (serializeJson(canonical) !== serializeJson(receipt)) {
    fail("download receipt is not in canonical form");
  }
  return canonical;
}

/** Verifies the directory is exactly the captured filename/size/digest set. */
export async function verifyDownloadedReleaseAssets(inventory, artifactRoot) {
  const canonicalInventory = validateStoredInventory(inventory);
  const entries = await readdir(artifactRoot, { withFileTypes: true });
  const nonFiles = entries
    .filter((entry) => !entry.isFile())
    .map((entry) => entry.name);
  if (nonFiles.length > 0) {
    fail(
      `download directory contains non-file entries: ${nonFiles.join(", ")}`,
    );
  }

  const expectedNames = canonicalInventory.assets
    .map((asset) => asset.name)
    .sort();
  const observedNames = entries.map((entry) => entry.name).sort();
  const expectedSet = new Set(expectedNames);
  const observedSet = new Set(observedNames);
  const missing = expectedNames.filter((name) => !observedSet.has(name));
  const unexpected = observedNames.filter((name) => !expectedSet.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      `downloaded filename set differs: missing=${missing.join(", ") || "none"}; unexpected=${unexpected.join(", ") || "none"}`,
    );
  }

  const assets = [];
  for (const asset of canonicalInventory.assets) {
    const filePath = path.join(artifactRoot, asset.name);
    const fileStats = await stat(filePath);
    if (!fileStats.isFile() || fileStats.size !== asset.sizeBytes) {
      fail(
        `${asset.name}: downloaded size ${fileStats.size} differs from captured size ${asset.sizeBytes}`,
      );
    }
    const downloadedSha256 = await sha256File(filePath);
    if (
      asset.githubDigest &&
      downloadedSha256 !== asset.githubDigest.slice("sha256:".length)
    ) {
      fail(
        `${asset.name}: downloaded SHA-256 ${downloadedSha256} differs from GitHub ${asset.githubDigest}`,
      );
    }
    assets.push({
      databaseId: asset.databaseId,
      nodeId: asset.nodeId,
      name: asset.name,
      sizeBytes: asset.sizeBytes,
      githubDigest: asset.githubDigest,
      downloadedSha256,
    });
  }

  return {
    schemaVersion: 1,
    inventorySha256: releaseAssetInventorySha256(canonicalInventory),
    assets,
  };
}

function escapeMarkdownTable(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("`", "&#96;");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Reviewer-readable receipt containing every captured and observed digest. */
export async function renderReleaseAssetReceiptMarkdown(inventory, receipt) {
  const canonicalInventory = validateStoredInventory(inventory);
  const canonicalDownloadReceipt = await canonicalReceipt(
    canonicalInventory,
    receipt,
  );
  const rows = canonicalDownloadReceipt.assets.map(
    (asset) =>
      `| ${asset.databaseId} | ${escapeMarkdownTable(asset.nodeId)} | ${escapeMarkdownTable(asset.name)} | ${asset.sizeBytes} | ${asset.githubDigest ?? "not supplied by GitHub"} | sha256:${asset.downloadedSha256} |`,
  );
  return [
    `- Release database ID: \`${canonicalInventory.release.databaseId}\``,
    `- Release node ID: \`${escapeMarkdownTable(canonicalInventory.release.nodeId)}\``,
    `- Published release tag: \`${escapeMarkdownTable(canonicalInventory.release.tagName)}\``,
    `- GitHub immutable flag: \`${canonicalInventory.release.immutable}\``,
    `- Canonical inventory SHA-256: \`${canonicalDownloadReceipt.inventorySha256}\``,
    `- Exact asset count: \`${canonicalDownloadReceipt.assets.length}\``,
    "",
    "| Asset database ID | Asset node ID | Exact filename | Bytes | GitHub SHA-256 | Downloaded SHA-256 |",
    "| ---: | --- | --- | ---: | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** Builds the evidence-complete draft PR body used by the recovery workflow. */
export async function renderRecoveryPullRequestBody({
  inventory,
  receipt,
  baseSha,
  tagSha,
  tag,
  manifestPath,
  runUrl,
  verificationLog,
}) {
  if (!fullGitShaPattern.test(baseSha)) fail("baseSha must be a full Git SHA");
  if (!fullGitShaPattern.test(tagSha)) fail("tagSha must be a full Git SHA");
  requireNonEmptyString(tag, "tag");
  requireNonEmptyString(manifestPath, "manifestPath");
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+\/attempts\/\d+$/.test(
      runUrl,
    )
  ) {
    fail("runUrl must identify one exact GitHub Actions run attempt");
  }
  const canonicalInventory = validateStoredInventory(inventory);
  if (canonicalInventory.release.tagName !== tag) {
    fail("PR tag differs from the captured release tag");
  }
  const assetReceipt = await renderReleaseAssetReceiptMarkdown(
    canonicalInventory,
    receipt,
  );
  const body = [
    "Manual OS manifest recovery generated by the fail-closed recovery workflow. This PR is intentionally draft and requires exact-head review before merge.",
    "",
    "## Exact recovery identity",
    "",
    `- Base branch: \`develop\``,
    `- Exact base SHA: \`${baseSha}\``,
    `- Release tag: \`${escapeMarkdownTable(tag)}\``,
    `- Exact tag commit SHA: \`${tagSha}\``,
    `- Manifest: \`${escapeMarkdownTable(manifestPath)}\``,
    `- Exact workflow logs: [run attempt](${runUrl})`,
    "",
    "The assets were downloaded by captured database ID into an empty directory. The verifier rejected missing, extra, non-file, size-mismatched, and digest-mismatched entries, and a second GitHub API capture matched the pre-download inventory exactly.",
    "",
    "## Evidence Gate",
    "",
    "<!-- evidence-row:before-screenshots -->",
    "- [x] N/A - workflow configuration and release metadata recovery have no rendered application surface.",
    "<!-- evidence-row:after-screenshots -->",
    "- [x] N/A - this draft changes only the tracked OS release manifest and renders no UI.",
    "<!-- evidence-row:walkthrough-video -->",
    "- [x] N/A - the non-interactive recovery transaction is fully recorded in the exact workflow run.",
    "<!-- evidence-row:backend-logs -->",
    `- [x] Exact capture, ID-based download, checksum, and drift-check logs: [workflow run attempt](${runUrl}).`,
    "<!-- evidence-row:frontend-logs -->",
    "- [x] N/A - no frontend source, request, response, or state transition is involved.",
    "<!-- evidence-row:llm-trajectory -->",
    "- [x] N/A - no agent, action, provider, prompt, model, or inference behavior is involved.",
    "<!-- evidence-row:domain-artifacts -->",
    `- [x] The exact release-asset inventory and downloaded-byte digests are recorded below and in the [immutable run receipt](${runUrl}); the proposed manifest is the sole PR diff.`,
    "",
    "## Immutable release asset receipt",
    "",
    assetReceipt.trimEnd(),
    "",
    "## Verification log receipt",
    "",
    `<details><summary>Exact commands and observed identities</summary><pre>${escapeHtml(verificationLog)}</pre></details>`,
    "",
    "No protected branch, Git tag, GitHub release, or release asset was mutated by this recovery. Only the dedicated recovery branch and this draft PR were created.",
    "",
  ].join("\n");
  if (Buffer.byteLength(body, "utf8") > maximumPullRequestBodyBytes) {
    fail(
      `recovery PR body exceeds ${maximumPullRequestBodyBytes} bytes; refuse to truncate exact receipts`,
    );
  }
  return body;
}

function requiredArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`--${name} is required`);
  }
  return value;
}

function usage() {
  process.stdout.write(`Usage:
  node packages/os/scripts/release-asset-inventory.mjs capture --repository <owner/repo> --release <release.json> --assets <assets.json> --output <inventory.json>
  node packages/os/scripts/release-asset-inventory.mjs plan --inventory <inventory.json>
  node packages/os/scripts/release-asset-inventory.mjs verify --inventory <inventory.json> --artifact-root <dir> --receipt <receipt.json> --markdown <receipt.md>
  node packages/os/scripts/release-asset-inventory.mjs compare --expected <inventory.json> --observed <inventory.json>
  node packages/os/scripts/release-asset-inventory.mjs render-pr --inventory <inventory.json> --receipt <receipt.json> --base-sha <sha> --tag-sha <sha> --tag <tag> --manifest <path> --run-url <url> --log <log> --output <body.md>
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._?.[0];
  if (!command || command === "help" || args.help) {
    usage();
    if (!command || args.help) process.exitCode = command ? 0 : 2;
    return;
  }

  if (command === "capture") {
    const inventory = createReleaseAssetInventory({
      repository: requiredArg(args, "repository"),
      release: await readJson(requiredArg(args, "release")),
      assets: await readJson(requiredArg(args, "assets")),
    });
    await writeJson(requiredArg(args, "output"), inventory);
    process.stdout.write(
      `Captured ${inventory.assets.length} release assets; inventory sha256=${releaseAssetInventorySha256(inventory)}\n`,
    );
    return;
  }

  if (command === "plan") {
    const inventory = validateStoredInventory(
      await readJson(requiredArg(args, "inventory")),
    );
    for (const asset of inventory.assets) {
      process.stdout.write(`${asset.databaseId}\t${asset.name}\n`);
    }
    return;
  }

  if (command === "verify") {
    const inventory = validateStoredInventory(
      await readJson(requiredArg(args, "inventory")),
    );
    const receipt = await verifyDownloadedReleaseAssets(
      inventory,
      path.resolve(requiredArg(args, "artifact-root")),
    );
    await writeJson(requiredArg(args, "receipt"), receipt);
    const markdownPath = requiredArg(args, "markdown");
    await writeFile(
      markdownPath,
      await renderReleaseAssetReceiptMarkdown(inventory, receipt),
    );
    process.stdout.write(
      `Verified exact filename, size, and digest set for ${receipt.assets.length} downloaded release assets\n`,
    );
    return;
  }

  if (command === "compare") {
    const expected = await readJson(requiredArg(args, "expected"));
    const observed = await readJson(requiredArg(args, "observed"));
    const inventory = assertReleaseAssetInventoriesEqual(expected, observed);
    process.stdout.write(
      `Post-download release inventory matches ${inventory.assets.length} captured assets exactly; inventory sha256=${releaseAssetInventorySha256(inventory)}\n`,
    );
    return;
  }

  if (command === "render-pr") {
    const inventory = await readJson(requiredArg(args, "inventory"));
    const receipt = await readJson(requiredArg(args, "receipt"));
    const verificationLog = await readFile(requiredArg(args, "log"), "utf8");
    const body = await renderRecoveryPullRequestBody({
      inventory,
      receipt,
      baseSha: requiredArg(args, "base-sha"),
      tagSha: requiredArg(args, "tag-sha"),
      tag: requiredArg(args, "tag"),
      manifestPath: requiredArg(args, "manifest"),
      runUrl: requiredArg(args, "run-url"),
      verificationLog,
    });
    await writeFile(requiredArg(args, "output"), body);
    process.stdout.write(
      `Rendered evidence-complete recovery PR body (${Buffer.byteLength(body, "utf8")} bytes)\n`,
    );
    return;
  }

  fail(`unknown command ${command}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
