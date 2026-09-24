/** Stages a verified, isolated BGE encoder bundle for the fused native text-model loader. */
import { BGE_EMBEDDING_MODEL } from "@elizaos/plugin-native-inference/model-catalog/bge-embedding-model";
import { ElizaError } from "@elizaos/core";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { statSync } from "node:fs";
import { symlinkSync } from "node:fs";
import path from "node:path";
export function verifyAospEmbeddingArtifact(modelPath: string): void {
    const actualHash = createHash("sha256")
        .update(readFileSync(modelPath))
        .digest("hex");
    if (actualHash !== BGE_EMBEDDING_MODEL.sha256) {
        throw new ElizaError("Install the pinned BGE-small embedding artifact before using local embeddings", {
            code: "EMBEDDING_ARTIFACT_INVALID",
            context: {
                modelPath,
                actualHash,
                expectedHash: BGE_EMBEDDING_MODEL.sha256,
            },
        });
    }
}
export function prepareAospEmbeddingBundle(modelPath: string): string {
    verifyAospEmbeddingArtifact(modelPath);
    const root = `${path.resolve(modelPath)}.embedding.bundle`;
    const textDir = path.join(root, "text");
    mkdirSync(textDir, { recursive: true });
    const target = path.join(textDir, BGE_EMBEDDING_MODEL.filename);
    if (!existsSync(target))
        symlinkSync(path.resolve(modelPath), target);
    const candidates = readdirSync(textDir);
    if (candidates.length !== 1 ||
        candidates[0] !== BGE_EMBEDDING_MODEL.filename ||
        !statSync(target).isFile()) {
        throw new ElizaError("The embedding bundle must contain only the pinned BGE encoder", {
            code: "EMBEDDING_ARTIFACT_INVALID",
            context: { root, candidates },
        });
    }
    verifyAospEmbeddingArtifact(target);
    return root;
}
