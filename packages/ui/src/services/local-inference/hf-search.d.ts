/**
 * HuggingFace Hub search for GGUF models.
 *
 * Calls `https://huggingface.co/api/models` with `filter=gguf` to narrow
 * results to repos that actually ship GGUF quantisations. Each matching
 * repo is expanded with `/api/models/<repo>` to pick a representative
 * quant file (preferring Q4_K_M when present). Results are shaped like
 * `CatalogModel` so the existing ModelCard renders them directly.
 *
 * We deliberately do not persist these — they're dynamic, and a curated
 * entry with the same hfRepo always takes precedence in the UI.
 */
import type { CatalogModel } from "./types";
/**
 * Search HuggingFace for GGUF repos matching `query`, returning
 * catalog-shaped entries ready for the Model Hub UI.
 */
export declare function searchHuggingFaceGguf(query: string, limit?: number): Promise<CatalogModel[]>;
/**
 * Search ModelScope for GGUF repos. ModelScope exposes reliable owner-list
 * and repo-file APIs, so this accepts either `owner/model` or an owner name
 * and filters the returned repos for GGUF files.
 */
export declare function searchModelScopeGguf(query: string, limit?: number): Promise<CatalogModel[]>;
export declare function searchModelHubGguf(query: string, hub?: "huggingface" | "modelscope", limit?: number): Promise<CatalogModel[]>;
//# sourceMappingURL=hf-search.d.ts.map