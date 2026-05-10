/**
 * `LIFEOPS` action — focused integration test for the pause / resume / wipe
 * verbs.
 *
 * Sister file to `global-pause.integration.test.ts` — that file covers the
 * pause-store contract; this one closes the gap from the audit at
 * `docs/audits/lifeops-2026-05-09/03-coverage-gap-matrix.md` line 442
 * by exercising the lifecycle the audit actually claimed was missing:
 *   - pause → resume returns the global-pause to inactive
 *   - pause with invalid endIso (endIso <= startIso) is rejected
 *   - wipe without confirmation surfaces the prompt
 *   - wipe with `confirmation: 'wipe'` (string token) succeeds
 *   - the action's `roleGate` is owner-only
 */

import type { Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lifeOpsPauseAction } from "../src/actions/lifeops-pause.ts";
import { createGlobalPauseStore } from "../src/lifeops/global-pause/store.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

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

let priorWorkspaceDir: string | undefined;

describe("LIFEOPS verb=pause/resume/wipe (action handler)", () => {
  beforeEach(() => {
    priorWorkspaceDir = process.env.MILADY_WORKSPACE_DIR;
  });

  afterEach(() => {
    if (priorWorkspaceDir === undefined) {
      delete process.env.MILADY_WORKSPACE_DIR;
    } else {
      process.env.MILADY_WORKSPACE_DIR = priorWorkspaceDir;
    }
  });

  it("declares OWNER role gate and pause/resume/wipe similes", () => {
    expect(lifeOpsPauseAction.name).toBe("LIFEOPS");
    expect(lifeOpsPauseAction.roleGate?.minRole).toBe("OWNER");
    const similes = lifeOpsPauseAction.similes ?? [];
    expect(similes).toContain("PAUSE_LIFEOPS");
    expect(similes).toContain("RESUME_LIFEOPS");
    expect(similes).toContain("WIPE_LIFEOPS");
  });

  it("pause then resume restores the store to inactive", async () => {
    const runtime = createMinimalRuntimeStub();
    const endIso = new Date(Date.now() + 86_400_000).toISOString();

    const pause = await lifeOpsPauseAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "pause"),
      undefined,
      { parameters: { verb: "pause", endIso, reason: "vacation" } },
      undefined,
      [],
    );
    expect(pause?.success).toBe(true);
    expect((await createGlobalPauseStore(runtime).current()).active).toBe(true);

    const resume = await lifeOpsPauseAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "resume"),
      undefined,
      { parameters: { verb: "resume" } },
      undefined,
      [],
    );
    expect(resume?.success).toBe(true);
    expect((await createGlobalPauseStore(runtime).current()).active).toBe(
      false,
    );
  });

  it("rejects pause window where endIso <= startIso", async () => {
    const runtime = createMinimalRuntimeStub();
    const startIso = new Date().toISOString();
    const endIso = new Date(Date.parse(startIso) - 1000).toISOString();

    const result = await lifeOpsPauseAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "pause"),
      undefined,
      { parameters: { verb: "pause", startIso, endIso } },
      undefined,
      [],
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { error?: string }).error).toBe(
      "INVALID_PAUSE_WINDOW",
    );
  });

  it("wipe with confirmation:'wipe' token succeeds without confirmed:true", async () => {
    const runtime = createMinimalRuntimeStub();

    // First seed a paused window so wipe has something to clear.
    await lifeOpsPauseAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "pause"),
      undefined,
      {
        parameters: {
          verb: "pause",
          endIso: new Date(Date.now() + 86_400_000).toISOString(),
        },
      },
      undefined,
      [],
    );
    expect((await createGlobalPauseStore(runtime).current()).active).toBe(true);

    const wipe = await lifeOpsPauseAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "wipe"),
      undefined,
      { parameters: { verb: "wipe", confirmation: "wipe" } },
      undefined,
      [],
    );
    expect(wipe?.success).toBe(true);
    expect((wipe?.data as { wiped?: boolean }).wiped).toBe(true);
    expect((await createGlobalPauseStore(runtime).current()).active).toBe(
      false,
    );
  });

  it("rejects wipe with no confirmation token at all", async () => {
    const runtime = createMinimalRuntimeStub();
    const result = await lifeOpsPauseAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "wipe"),
      undefined,
      { parameters: { verb: "wipe" } },
      undefined,
      [],
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { error?: string }).error).toBe(
      "CONFIRMATION_REQUIRED",
    );
    expect(
      (result?.data as { requiresConfirmation?: boolean })
        .requiresConfirmation,
    ).toBe(true);
  });

  it("rejects unknown verb", async () => {
    const runtime = createMinimalRuntimeStub();
    const result = await lifeOpsPauseAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "do something"),
      undefined,
      { parameters: { verb: "bogus" } },
      undefined,
      [],
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { error?: string }).error).toBe("INVALID_VERB");
  });
});
