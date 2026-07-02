/**
 * OS-level blocking lifecycle, end to end and unmocked: the real SelfControl
 * engine writes a temp hosts file (harness sets the engine config override),
 * the real reader/writer hit PGlite, and the reconciler converges the two.
 *
 * Covers the four lifecycle findings:
 *  - gate release reconciles OS state (hosts block removed, not just
 *    `active = FALSE`),
 *  - fixed_duration expiry releases the rule and the hosts block,
 *  - the HTTP DELETE route refuses while a harsh_no_bypass rule is active,
 *    and the reconciler re-asserts blocks removed out-of-band,
 *  - activation failure is surfaced per tick and retried until it succeeds.
 */

import path from "node:path";
import type { UUID } from "@elizaos/core";
import {
  setSelfControlPluginConfig,
  startSelfControlBlock,
} from "@elizaos/plugin-blocker/services/website-blocker/index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebsiteBlockerRouteContext } from "../../../routes/website-blocker-routes.js";
import { handleWebsiteBlockerRoutes } from "../../../routes/website-blocker-routes.js";
import { reconcileBlockRulesOnce } from "../block-rule-reconciler.js";
import { BlockRuleReader, BlockRuleWriter } from "../block-rule-service.js";
import {
  type BlockRuleTestHarness,
  completeTodo,
  createBlockRuleHarness,
  seedTodo,
} from "./test-harness.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000dddd" as UUID;

function expectHostsBlocked(harness: BlockRuleTestHarness): void {
  const hosts = harness.readHosts();
  expect(hosts).toContain("# >>> eliza-selfcontrol >>>");
  expect(hosts).toContain("0.0.0.0 x.com");
}

function expectHostsClean(harness: BlockRuleTestHarness): void {
  expect(harness.readHosts()).not.toContain("eliza-selfcontrol");
}

interface CapturedResponse {
  status: number | null;
  body: unknown;
}

function buildDeleteContext(harness: BlockRuleTestHarness): {
  ctx: WebsiteBlockerRouteContext;
  captured: CapturedResponse;
} {
  const captured: CapturedResponse = { status: null, body: null };
  const ctx = {
    req: { url: "/api/website-blocker", method: "DELETE" },
    res: {},
    method: "DELETE",
    pathname: "/api/website-blocker",
    readJsonBody: async () => null,
    json: (_res: unknown, body: unknown, status = 200) => {
      captured.body = body;
      captured.status = status;
    },
    error: (_res: unknown, message: string, status = 500) => {
      captured.body = { success: false, error: message };
      captured.status = status;
    },
    runtime: harness.runtime,
  } as unknown as WebsiteBlockerRouteContext;
  return { ctx, captured };
}

describe("website-blocker OS lifecycle (real hosts file)", () => {
  let harness: BlockRuleTestHarness;

  beforeEach(async () => {
    harness = await createBlockRuleHarness(AGENT_ID);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("until_todo: completing the gate todo releases the rule AND the hosts block", async () => {
    await seedTodo(harness, { id: "todo-os-1", title: "Ship it" });
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);

    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-os-1",
    });
    expectHostsBlocked(harness);

    let result = await reconcileBlockRulesOnce(harness.runtime);
    expect(result.releasedRuleIds).toEqual([]);
    expect(result.osSync.ok).toBe(true);
    expectHostsBlocked(harness);

    await completeTodo(harness, "todo-os-1");
    result = await reconcileBlockRulesOnce(harness.runtime);
    expect(result.releasedRuleIds).toEqual([id]);
    expect(result.osSync.ok).toBe(true);
    expect((await reader.getBlockRuleById(id))?.active).toBe(false);
    expectHostsClean(harness);
  });

  it("fixed_duration: expiry releases the rule and removes the hosts block", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);
    const durationMs = 60 * 60_000;

    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "fixed_duration",
      fixedDurationMs: durationMs,
    });
    expectHostsBlocked(harness);
    const createdAt = (await reader.getBlockRuleById(id))?.createdAt;
    expect(createdAt).toBeTypeOf("number");
    const created = createdAt as number;

    let result = await reconcileBlockRulesOnce(
      harness.runtime,
      created + durationMs / 2,
    );
    expect(result.releasedRuleIds).toEqual([]);
    expectHostsBlocked(harness);

    result = await reconcileBlockRulesOnce(
      harness.runtime,
      created + durationMs + 60_000,
    );
    expect(result.releasedRuleIds).toEqual([id]);
    expect(result.osSync.ok).toBe(true);
    expect((await reader.getBlockRuleById(id))?.releasedReason).toBe(
      "fixed_duration_elapsed",
    );
    expectHostsClean(harness);
  });

  it("releaseBlockRule (confirmed user release) removes the hosts block, not just the row", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-os-2",
    });
    expectHostsBlocked(harness);

    await writer.releaseBlockRule(id, {
      confirmed: true,
      reason: "changed-my-mind",
    });
    expectHostsClean(harness);
  });

  it("DELETE /api/website-blocker is refused while a harsh_no_bypass rule is active", async () => {
    await seedTodo(harness, { id: "todo-os-3", title: "Hard gate" });
    const writer = new BlockRuleWriter(harness.runtime);
    await writer.createBlockRule({
      profile: "harsh",
      websites: ["x.com"],
      gateType: "harsh_no_bypass",
      gateTodoId: "todo-os-3",
    });
    expectHostsBlocked(harness);

    const { ctx, captured } = buildDeleteContext(harness);
    expect(await handleWebsiteBlockerRoutes(ctx)).toBe(true);
    expect(captured.status).toBe(423);
    expect(captured.body).toMatchObject({ success: false });
    expect(String((captured.body as { error: string }).error)).toMatch(
      /harsh-no-bypass/,
    );
    expectHostsBlocked(harness);

    // The only way out is fulfilling the gate.
    await completeTodo(harness, "todo-os-3");
    const result = await reconcileBlockRulesOnce(harness.runtime);
    expect(result.releasedRuleIds).toHaveLength(1);
    expectHostsClean(harness);
  });

  it("DELETE succeeds without harsh rules, and the reconciler re-asserts a still-gated rule's block", async () => {
    await seedTodo(harness, { id: "todo-os-4", title: "Soft gate" });
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);
    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-os-4",
    });
    expectHostsBlocked(harness);

    const { ctx, captured } = buildDeleteContext(harness);
    expect(await handleWebsiteBlockerRoutes(ctx)).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ success: true, removed: true });
    expectHostsClean(harness);

    // The rule is still active, so the reconciler brings the block back.
    const result = await reconcileBlockRulesOnce(harness.runtime);
    expect(result.osSync).toMatchObject({ ok: true, changed: true });
    expect((await reader.getBlockRuleById(id))?.active).toBe(true);
    expectHostsBlocked(harness);
  });

  it("a manually started OS block is never torn down by the rule lifecycle", async () => {
    // The user starts their own block outside the rule system (no managedBy).
    const manual = await startSelfControlBlock({
      websites: ["reddit.com"],
      durationMinutes: null,
      scheduledByAgentId: null,
    });
    expect(manual.success).toBe(true);
    expect(harness.readHosts()).toContain("0.0.0.0 reddit.com");

    // Rules cannot engage while the foreign block runs — reported honestly,
    // and the user's block is left exactly as it was.
    const writer = new BlockRuleWriter(harness.runtime);
    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-os-6",
    });
    let result = await reconcileBlockRulesOnce(harness.runtime);
    expect(result.osSync.ok).toBe(false);
    expect(result.osSync.error).toMatch(/not managed by block rules/);
    expect(harness.readHosts()).toContain("0.0.0.0 reddit.com");
    expect(harness.readHosts()).not.toContain("0.0.0.0 x.com");

    // Releasing the last rule syncs to "no rules" — the foreign block must
    // survive that too (the sync only stops rule-managed blocks).
    await writer.releaseBlockRule(id, { confirmed: true });
    result = await reconcileBlockRulesOnce(harness.runtime);
    expect(result.osSync).toMatchObject({ ok: true, changed: false });
    expect(harness.readHosts()).toContain("0.0.0.0 reddit.com");
  });

  it("activation failure is surfaced by the reconciler and retried until it succeeds", async () => {
    // Point the engine at a hosts file that does not exist: activation fails.
    const missingHostsPath = path.join(
      path.dirname(harness.hostsFilePath),
      "missing",
      "hosts",
    );
    setSelfControlPluginConfig({
      hostsFilePath: missingHostsPath,
      validateSystemResolution: false,
      statusCacheTtlMs: 0,
    });

    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);
    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-os-5",
    });

    // The rule (source of truth) exists, but nothing is enforced — the
    // reconciler reports that honestly on every tick.
    expect((await reader.getBlockRuleById(id))?.active).toBe(true);
    expectHostsClean(harness);
    let result = await reconcileBlockRulesOnce(harness.runtime);
    expect(result.osSync.ok).toBe(false);
    expect(result.osSync.error).toBeTruthy();
    expectHostsClean(harness);

    // Once the engine works again, the next tick converges without any
    // rule-side intervention.
    setSelfControlPluginConfig({
      hostsFilePath: harness.hostsFilePath,
      validateSystemResolution: false,
      statusCacheTtlMs: 0,
    });
    result = await reconcileBlockRulesOnce(harness.runtime);
    expect(result.osSync).toMatchObject({ ok: true, changed: true });
    expectHostsBlocked(harness);
  });
});
