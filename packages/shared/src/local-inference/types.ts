/**
 * Local inference shared types.
 *
 * This module hosts the **shared subset** of local-inference types that
 * both the server-side service in `@elizaos/app-core` and the UI client in
 * `@elizaos/ui` need to reference identically. The richer, server-side
 * types (DFlash kernels, optimization knobs, runtime backend metadata,
 * loaded KV cache reporting, etc.) intentionally live in
 * `@elizaos/app-core/src/services/local-inference/types.ts` only — they
 * describe the server runtime and have no UI consumer.
 *
 * Adding a new shared type here is appropriate when:
 *   - It is referenced by both `app-core` and `ui` packages, and
 *   - Both sides need the exact same shape (no subset/superset drift).
 *
 * If a UI consumer needs a richer view, prefer extending the type in
 * `app-core` and re-exporting via UI rather than widening this shared
 * module.
 */

/** Agent slot ids the runtime maps to a local model. */
export type AgentModelSlot = "TEXT_SMALL" | "TEXT_LARGE" | "TEXT_EMBEDDING";

/** Subset of `AgentModelSlot` that participates in text generation. */
export type TextGenerationSlot = Extract<
  AgentModelSlot,
  "TEXT_SMALL" | "TEXT_LARGE"
>;

export const AGENT_MODEL_SLOTS: AgentModelSlot[] = [
  "TEXT_SMALL",
  "TEXT_LARGE",
  "TEXT_EMBEDDING",
];

/**
 * Mapping of agent slot → installed model id. Persisted to disk by
 * `assignments.ts` and consumed by both the runtime router and the UI
 * model picker.
 */
export type ModelAssignments = Partial<Record<AgentModelSlot, string>>;

/**
 * Installed-model registry entry. The on-disk format is JSON; this is the
 * canonical TypeScript shape both packages parse against.
 */
export interface InstalledModel {
  /** Matches CatalogModel.id when installed from the curated catalog. */
  id: string;
  displayName: string;
  /** Absolute path to the GGUF file on disk. */
  path: string;
  sizeBytes: number;
  /** HF repo this came from, when known. */
  hfRepo?: string;
  /** ISO timestamp of install completion. */
  installedAt: string;
  /** ISO timestamp of last activation (null if never loaded). */
  lastUsedAt: string | null;
  /** Where we got this model from. Determines whether Eliza owns the file. */
  source: "eliza-download" | "external-scan";
  /**
   * When source === "external-scan", which tool the file belonged to.
   * Prevents Eliza from deleting files other apps own.
   */
  externalOrigin?:
    | "lm-studio"
    | "jan"
    | "ollama"
    | "huggingface"
    | "text-gen-webui";
  /** SHA256 of the GGUF file recorded at install time. Optional for legacy entries. */
  sha256?: string;
  /** ISO timestamp of the last successful re-verification. Absent = never verified since install. */
  lastVerifiedAt?: string;
  runtimeRole?: "chat" | "dflash-drafter";
  companionFor?: string;
}
