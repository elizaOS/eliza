/**
 * Discover GGUF files already on disk from other local-inference tools.
 *
 * Users often have LM Studio, Jan, Ollama, or raw HuggingFace downloads
 * lying around. We scan their default cache paths and surface those models
 * in the Model Hub with `source: "external-scan"` so Eliza can load them
 * without re-downloading. Eliza never modifies or deletes these files —
 * the uninstall endpoint refuses when `source !== "eliza-download"`.
 *
 * Ollama is special: its blobs live under `models/blobs/sha256-*` with no
 * `.gguf` extension, and the human name only exists in adjacent manifests.
 * We parse the manifests to recover the mapping; blobs we can't map stay
 * hidden rather than surfacing as opaque hashes.
 */
import type { InstalledModel } from "./types";
export declare function scanExternalModels(): Promise<InstalledModel[]>;
//# sourceMappingURL=external-scanner.d.ts.map
