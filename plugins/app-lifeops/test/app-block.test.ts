/**
 * `APP_BLOCK` handler test.
 *
 * Closes the gap from `docs/audits/lifeops-2026-05-09/03-coverage-gap-matrix.md`
 * line 438: the app-block handler had no executable test.
 *
 * Covers the three subactions (`block`, `unblock`, `status`) by mocking the
 * `app-blocker/engine.ts` surface — the single side-effect path the handler
 * dispatches into. The planner / arg-resolver path is bypassed by passing
 * parameters explicitly through `options.parameters`, so this is a true
 * handler-level integration: arg resolution → access gate → engine dispatch →
 * ActionResult shape.
 *
 * Owner-only access is exercised via `entityId === agentId` so the
 * `getAppBlockerAccess` helper takes the isAgentSelf shortcut.
 */

import type { Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

interface BlockCall {
  packageNames?: string[];
  appTokens?: string[];
  durationMinutes?: number | null;
}

const stubState = {
  active: false,
  blockedCount: 0,
  blockedPackageNames: [] as string[],
  endsAt: null as string | null,
  platform: "android" as "android" | "ios",
  permissionStatus: "granted" as "granted" | "denied",
};
const stubCalls = { block: [] as BlockCall[], unblock: 0 };

vi.mock("../src/app-blocker/engine.js", () => ({
  async getAppBlockerStatus() {
    return {
      available: true,
      permissionStatus: stubState.permissionStatus,
      active: stubState.active,
      blockedCount: stubState.blockedCount,
      blockedPackageNames: stubState.blockedPackageNames,
      endsAt: stubState.endsAt,
      platform: stubState.platform,
      engine: "test-stub",
    };
  },
  async getInstalledApps() {
    return [
      { displayName: "Twitter", packageName: "com.twitter.android" },
      { displayName: "Instagram", packageName: "com.instagram.android" },
    ];
  },
  async startAppBlock(options: BlockCall) {
    stubCalls.block.push(options);
    const blockedCount =
      (options.packageNames?.length ?? 0) + (options.appTokens?.length ?? 0);
    const endsAt =
      typeof options.durationMinutes === "number"
        ? new Date(Date.now() + options.durationMinutes * 60_000).toISOString()
        : null;
    stubState.active = true;
    stubState.blockedCount = blockedCount;
    stubState.blockedPackageNames = options.packageNames ?? [];
    stubState.endsAt = endsAt;
    return { success: true, blockedCount, endsAt };
  },
  async stopAppBlock() {
    stubCalls.unblock += 1;
    stubState.active = false;
    stubState.blockedCount = 0;
    stubState.blockedPackageNames = [];
    stubState.endsAt = null;
    return { success: true };
  },
}));

// Audit F folded the standalone `APP_BLOCK` action into a handler function;
// the BLOCK umbrella in `./block.ts` is the only registered action.
const { runAppBlockHandler } = await import("../src/actions/app-block.js");
const { createMinimalRuntimeStub } = await import("./first-run-helpers.js");

function ownerMessage(agentId: UUID, text: string): Memory {
  return {
    id: ("msg-" + Math.random().toString(36).slice(2, 8)) as UUID,
    entityId: agentId,
    roomId: agentId,
    agentId,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

function resetStub(initial: Partial<typeof stubState> = {}) {
  stubState.active = initial.active ?? false;
  stubState.blockedCount = initial.blockedCount ?? 0;
  stubState.blockedPackageNames = initial.blockedPackageNames ?? [];
  stubState.endsAt = initial.endsAt ?? null;
  stubState.platform = initial.platform ?? "android";
  stubState.permissionStatus = initial.permissionStatus ?? "granted";
  stubCalls.block.length = 0;
  stubCalls.unblock = 0;
}

describe("runAppBlockHandler", () => {
  it("block subaction dispatches startAppBlock with the supplied package list and duration", async () => {
    const runtime = createMinimalRuntimeStub();
    resetStub({ platform: "android" });

    const result = await runAppBlockHandler(
      runtime,
      ownerMessage(runtime.agentId, "block twitter for 60 minutes"),
      undefined,
      {
        parameters: {
          subaction: "block",
          intent: "block twitter for 60 minutes",
          packageNames: ["com.twitter.android"],
          durationMinutes: 60,
        },
      },
    );

    if (!result?.success) {
      throw new Error(
        "expected APP_BLOCK to succeed; got: " +
          JSON.stringify({ text: result?.text, data: result?.data }),
      );
    }
    expect(result?.success).toBe(true);
    expect(stubCalls.block).toHaveLength(1);
    expect(stubCalls.block[0]?.packageNames).toEqual(["com.twitter.android"]);
    expect(stubCalls.block[0]?.durationMinutes).toBe(60);
    expect(result?.text ?? "").toMatch(/Started blocking 1 app/);
    expect(
      (result?.data as { blockedCount?: number } | undefined)?.blockedCount,
    ).toBe(1);
  });

  it("status subaction returns active=false when nothing is blocked", async () => {
    const runtime = createMinimalRuntimeStub();
    resetStub({ active: false });

    const result = await runAppBlockHandler(
      runtime,
      ownerMessage(runtime.agentId, "is anything blocked"),
      undefined,
      { parameters: { subaction: "status" } },
    );

    expect(result?.success).toBe(true);
    expect((result?.data as { active?: boolean } | undefined)?.active).toBe(
      false,
    );
    expect(result?.text ?? "").toMatch(/No app block/);
  });

  it("unblock subaction clears the active block", async () => {
    const runtime = createMinimalRuntimeStub();
    resetStub({
      active: true,
      blockedCount: 2,
      blockedPackageNames: ["com.twitter.android", "com.instagram.android"],
      endsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });

    const result = await runAppBlockHandler(
      runtime,
      ownerMessage(runtime.agentId, "unblock my apps"),
      undefined,
      { parameters: { subaction: "unblock" } },
    );

    expect(result?.success).toBe(true);
    expect(stubCalls.unblock).toBe(1);
    expect(result?.text ?? "").toMatch(/Removed the app block/);
  });

  it("status subaction surfaces blockedPackageNames + endsAt when active", async () => {
    const runtime = createMinimalRuntimeStub();
    const endsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    resetStub({
      active: true,
      blockedCount: 1,
      blockedPackageNames: ["com.twitter.android"],
      endsAt,
    });

    const result = await runAppBlockHandler(
      runtime,
      ownerMessage(runtime.agentId, "what is blocked right now"),
      undefined,
      { parameters: { subaction: "status" } },
    );

    expect(result?.success).toBe(true);
    const data = result?.data as
      | {
          active?: boolean;
          blockedCount?: number;
          blockedPackageNames?: string[];
          endsAt?: string;
        }
      | undefined;
    expect(data?.active).toBe(true);
    expect(data?.blockedCount).toBe(1);
    expect(data?.blockedPackageNames).toEqual(["com.twitter.android"]);
    expect(data?.endsAt).toBe(endsAt);
  });
});
