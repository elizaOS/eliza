/**
 * Live multi-account E2E — runs against the operator's REAL linked accounts.
 *
 * Gated by `ORCHESTRATOR_LIVE_MULTI_ACCOUNT=1`; skipped (and green) otherwise so
 * it never runs in normal CI. It validates the load-bearing claims of the
 * multi-account coding-agent feature against real credentials:
 *   - the coding-agent selector bridge resolves a real access token per account
 *   - least-used rotation hands out DISTINCT accounts across spawns (with the
 *     pool's exclude set), proving sub-agents spread across subscriptions
 *   - live usage probes return the current session/weekly utilization that the
 *     dashboard + Settings render
 *
 * Connect ≥2 accounts for at least one provider (Claude subscription or Codex)
 * via the Settings → Accounts window first, then:
 *   ORCHESTRATOR_LIVE_MULTI_ACCOUNT=1 bun run --cwd packages/app-core test -- coding-account-bridge.live
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  __resetDefaultAccountPoolForTests,
  getDefaultAccountPool,
} from "./account-pool.js";
import { getCodingAgentSelectorBridge } from "./coding-account-bridge.js";

const LIVE = process.env.ORCHESTRATOR_LIVE_MULTI_ACCOUNT === "1";
const d = LIVE ? describe : describe.skip;

const CODING_PROVIDERS: LinkedAccountProviderId[] = [
  "anthropic-subscription",
  "openai-codex",
];

d("multi-account live (real linked accounts)", () => {
  it("rotates least-used across distinct real accounts and resolves tokens", async () => {
    __resetDefaultAccountPoolForTests();
    const pool = getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();
    expect(bridge).not.toBeNull();
    if (!bridge) return;

    const multiProvider = CODING_PROVIDERS.find(
      (p) => pool.list(p).filter((a) => a.enabled).length >= 2,
    );
    if (!multiProvider) {
      throw new Error(
        "Connect ≥2 accounts for a Claude subscription or Codex provider, then re-run.",
      );
    }
    const agentType =
      multiProvider === "anthropic-subscription" ? "claude" : "codex";

    // Round-robin two selections with the just-picked account excluded: the
    // pool must hand out a different real account, each with a usable token.
    const first = await bridge.select(agentType, { strategy: "least-used" });
    expect(first?.accountId).toBeTruthy();
    expect(Object.keys(first?.envPatch ?? {}).length).toBeGreaterThan(0);

    const second = await bridge.select(agentType, {
      strategy: "least-used",
      exclude: first ? [first.accountId] : [],
    });
    expect(second?.accountId).toBeTruthy();
    expect(second?.accountId).not.toBe(first?.accountId);

    // Every credential the bridge returns must be a real, non-empty secret.
    for (const sel of [first, second]) {
      for (const value of Object.values(sel?.envPatch ?? {})) {
        expect(typeof value).toBe("string");
        expect(value.length).toBeGreaterThan(8);
      }
    }
  });

  it("reports live session/weekly usage for each connected account", async () => {
    __resetDefaultAccountPoolForTests();
    const pool = getDefaultAccountPool();
    let probed = 0;
    for (const provider of CODING_PROVIDERS) {
      for (const account of pool.list(provider).filter((a) => a.enabled)) {
        const { getAccessToken } = await import(
          "@elizaos/agent/auth/credentials"
        );
        const token = await getAccessToken(provider, account.id);
        if (!token) continue;
        await pool.refreshUsage(account.id, token, {
          providerId: provider,
          ...(account.organizationId
            ? { codexAccountId: account.organizationId }
            : {}),
        });
        const refreshed = pool.list(provider).find((a) => a.id === account.id);
        // Anthropic reports session + weekly; Codex reports session only.
        expect(typeof refreshed?.usage?.sessionPct).toBe("number");
        probed += 1;
      }
    }
    expect(probed).toBeGreaterThan(0);
  });
});
