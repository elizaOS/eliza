// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * `usbeliza-codegen` plugin.
 *
 * Phase 0 scaffold: the public surface only. The `generate-app` action that
 * spawns `claude --print --output-format stream-json --dangerously-skip-permissions`,
 * parses streamed tool calls, validates the manifest via `eliza-sandbox`, and
 * writes `~/.eliza/apps/<slug>/` lands in milestone #11.
 *
 * The boundary type `CodeGeneratorBackend` is the seam locked decision #19
 * commits to: Phase 1.5 swaps in a `ManagedProxy` impl alongside `Claude`
 * and `Codex` without changing this plugin's call sites.
 */

import type { CalibrationBlock } from "../../persona.ts";

/**
 * Available code generation backends. Phase 0 ships only `claude`. Phase 1
 * adds `codex` and `local-llama`. Phase 1.5 adds `managed-proxy`.
 */
export type CodeGeneratorBackend = "claude" | "codex" | "local-llama" | "managed-proxy";

export interface GenerationBrief {
    /** Stable slug for the app. URL-safe; used as a directory name. */
    slug: string;
    /** Free-text user intent that triggered this generation. */
    intent: string;
    /** Optional existing source for an in-place rebuild/patch. */
    existingSrc?: string;
    /**
     * The user's calibration block — fed to the LLM so generated apps match
     * the user's tone, theme bias, and tool-density preference.
     */
    calibration: CalibrationBlock | null;
}

export interface GenerationOutput {
    /** The slug the LLM produced output for (echoes the brief on success). */
    slug: string;
    /** Path to the resulting `manifest.json` on disk. */
    manifestPath: string;
    /** Path to the resulting `src/` directory on disk. */
    srcPath: string;
    /** The backend that produced this output. */
    backend: CodeGeneratorBackend;
}
