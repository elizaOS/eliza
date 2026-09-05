/** Packages the verified default embedding GGUF with Android local-runtime assets. */
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  ensureEmbeddingArtifact,
  FUSED_EMBEDDING_ARTIFACT,
} from "../ensure-fused-inference-install.mjs";

export async function stageAndroidEmbedding(
  assetsAgentDir,
  {
    ensureEmbedding = ensureEmbeddingArtifact,
    artifact = FUSED_EMBEDDING_ARTIFACT,
  } = {},
) {
  if (path.basename(artifact.filename) !== artifact.filename)
    throw new Error("Android embedding artifact filename must be a basename");
  const installed = await ensureEmbedding();
  const bytes = readFileSync(installed.path);
  if (
    bytes.length !== artifact.size ||
    createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
  )
    throw new Error(
      "Android embedding source failed pinned size/hash verification",
    );
  const directory = path.join(assetsAgentDir, "embedding");
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, artifact.filename);
  const current = existsSync(target) ? readFileSync(target) : null;
  const modelChanged =
    !current ||
    current.length !== artifact.size ||
    createHash("sha256").update(current).digest("hex") !== artifact.sha256;
  const pending = `${target}.${randomUUID()}.pending`;
  if (modelChanged)
    try {
      copyFileSync(installed.path, pending);
      const staged = readFileSync(pending);
      if (
        staged.length !== artifact.size ||
        createHash("sha256").update(staged).digest("hex") !== artifact.sha256
      )
        throw new Error("Android embedding source changed during staging");
      renameSync(pending, target);
    } finally {
      rmSync(pending, { force: true });
    }
  const manifest = path.join(directory, "manifest.json");
  const metadata = `${JSON.stringify({ filename: artifact.filename, size: artifact.size, sha256: artifact.sha256 }, null, 2)}\n`;
  const manifestChanged =
    !existsSync(manifest) || readFileSync(manifest, "utf8") !== metadata;
  if (manifestChanged) {
    const pendingManifest = `${manifest}.${randomUUID()}.pending`;
    try {
      writeFileSync(pendingManifest, metadata);
      renameSync(pendingManifest, manifest);
    } finally {
      rmSync(pendingManifest, { force: true });
    }
  }
  return {
    modelPath: target,
    manifestPath: manifest,
    changed: Number(modelChanged) + Number(manifestChanged),
  };
}
