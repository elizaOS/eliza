// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Boot-time model picker — runs during the calibration flow to suggest
 * which local-inference tier the host should download as its default.
 *
 * Algorithm (deliberately simple — the picker UX is a chat, not a wizard):
 *
 *   1. Probe host RAM via `/proc/meminfo` MemTotal.
 *   2. Filter catalog tiers via `pickEligibleTiers` (memory-aware).
 *   3. Score each eligible tier by `minRamGb` (more RAM → bigger model).
 *   4. Return the top N (default 3) as ranked suggestions.
 *
 * The picker returns a `PickResult` containing the recommended tier and
 * the runner-up alternatives — elizad's calibration step can show all
 * three and let the user pick, or auto-commit to `recommended` on a
 * timeout.
 */

import { readFileSync } from "node:fs";

import {
    type CatalogModel,
    findCatalogModel,
    findDflashDrafter,
    pickEligibleTiers,
    BASELINE_MODEL_ID,
} from "./catalog.ts";

export interface PickResult {
    /** Highest-tier model that fits the host (with DFlash drafter if applicable). */
    readonly recommended: CatalogModel;
    /** Optional drafter model when `recommended.dflashDrafter !== undefined`. */
    readonly drafter?: CatalogModel;
    /** Other tiers the user could pick instead, ordered largest-first. */
    readonly alternatives: readonly CatalogModel[];
    /** Probed host RAM in GB (rounded down). */
    readonly hostRamGb: number;
}

/**
 * Pure-input variant of {@link recommendModelTier} — accepts `memTotalGb`
 * directly. Used by tests; production callers want
 * {@link recommendModelTier} which probes `/proc/meminfo`.
 */
export function recommendModelTierFor(memTotalGb: number): PickResult {
    const eligible = pickEligibleTiers(memTotalGb);
    if (eligible.length === 0) {
        // pickEligibleTiers guarantees at least the baseline tier, but
        // be defensive — a host so RAM-starved it can't even fit
        // tiny-1b's 6 GB minimum (2 GB model + 4 GB headroom) is a real
        // possibility on 4 GB low-end laptops. Surface baseline anyway;
        // the agent will hard-fail at load time with a clear message
        // rather than booting into a model picker with no options.
        const baseline = findCatalogModel(BASELINE_MODEL_ID);
        if (baseline === undefined) {
            throw new Error(`catalog missing baseline tier ${BASELINE_MODEL_ID}`);
        }
        return {
            recommended: baseline,
            alternatives: [],
            hostRamGb: memTotalGb,
        };
    }
    const recommended = eligible[0];
    if (recommended === undefined) {
        throw new Error("unreachable: pickEligibleTiers returned non-empty array");
    }
    const drafter = findDflashDrafter(recommended);
    const alternatives = eligible.slice(1);
    return {
        recommended,
        ...(drafter !== undefined ? { drafter } : {}),
        alternatives,
        hostRamGb: memTotalGb,
    };
}

/**
 * Probe `/proc/meminfo` and recommend a model tier. The MemTotal line
 * is in kB by convention (since procps/Linux 2.6) — we divide by
 * 1024² to get GiB and round down so a host with 15.9 GiB doesn't get
 * suggested a tier requiring 16.
 */
export function recommendModelTier(): PickResult {
    const memInfo = readFileSync("/proc/meminfo", "utf8");
    const match = /^MemTotal:\s+(\d+)\s+kB/m.exec(memInfo);
    if (match === null || match[1] === undefined) {
        throw new Error("could not parse /proc/meminfo MemTotal");
    }
    const memTotalKb = parseInt(match[1], 10);
    if (Number.isNaN(memTotalKb) || memTotalKb <= 0) {
        throw new Error(`invalid MemTotal value: ${match[1]}`);
    }
    const memTotalGb = Math.floor(memTotalKb / (1024 * 1024));
    return recommendModelTierFor(memTotalGb);
}

/**
 * Format a {@link PickResult} as a chat-renderable string. The picker's
 * "UI" is whatever Eliza says in the calibration flow — this gives a
 * deterministic, testable shape.
 */
export function formatPickResultForChat(result: PickResult): string {
    const lines: string[] = [];
    lines.push(
        `Detected ${result.hostRamGb} GB of RAM. Recommended: **${result.recommended.displayName}** (${result.recommended.sizeGb.toFixed(1)} GB).`,
    );
    lines.push(`> ${result.recommended.blurb}`);
    if (result.drafter !== undefined) {
        lines.push(
            `Will also download **${result.drafter.displayName}** (${result.drafter.sizeGb.toFixed(1)} GB) as the speculative-decoding drafter.`,
        );
    }
    if (result.alternatives.length > 0) {
        lines.push("");
        lines.push("Alternatives:");
        for (const alt of result.alternatives) {
            lines.push(`- **${alt.displayName}** (${alt.sizeGb.toFixed(1)} GB) — ${alt.blurb}`);
        }
    }
    return lines.join("\n");
}
