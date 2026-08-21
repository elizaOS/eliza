/**
 * Pre-spawn intent gate: TASKS_SPAWN_AGENT / TASKS_CREATE must refuse — BEFORE
 * any ACP session exists — when the task prompt is empty or derived only from
 * a shared link (bare URL + connector embed preview, no explicit instruction
 * in the user's own words). Live incident: a bare Discord URL whose embed
 * title contained workflow-ish words spawned a coding sub-agent with
 * body/instruction/input all empty; the doomed session dead-ended and the
 * user saw "runtime step failed". Deterministic — drives the REAL tasksAction
 * handler against a fake ACP service; no live model.
 *
 * Also pins the refusal's leak contract: the redirect instruction is
 * planner-facing `data.plannerGuidance`, never `text`/`userFacingText`, and a
 * refusal is never promoted to verified canonical copy — the promotion path
 * shipped the raw "Refused to spawn…" envelope to chat verbatim (live
 * tj-f1e0716132eb14, a shared docs.warp.dev link).
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { tasksAction } from "../actions/tasks.ts";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MSG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

/** The exact processed-content shape Discord produces for a shared link with
 * a rendered preview: the raw URL plus the connector-appended embed block. */
const LINK_SHARE_TEXT = [
  "https://claude.ai/public/artifacts/abc123",
  "Embed #1:",
  "  Title:how the agent decides to message people",
  "  Description:(none)",
].join("\n");

function makeFakeAcp() {
  const spawnSession = vi.fn(async (opts: Record<string, unknown>) => ({
    sessionId: "session-1",
    agentType: (opts.agentType as string) ?? "codex",
    workdir: (opts.workdir as string) ?? "/tmp/spawn-test",
    status: "running",
  }));
  const service = {
    spawnSession,
    getSession: vi.fn(async () => undefined),
    getSessions: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    stopSession: vi.fn(async () => undefined),
    resolveAgentType: vi.fn(async () => "codex"),
    onSessionEvent: vi.fn(() => () => undefined),
  };
  return { service, spawnSession };
}

function makeRuntime(
  acp: ReturnType<typeof makeFakeAcp>["service"],
  options: { appAction?: boolean } = {},
) {
  return {
    agentId: AGENT_ID,
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    getService: (type: string) => {
      if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE")
        return acp;
      return undefined;
    },
    reportError: vi.fn(),
    emitEvent: vi.fn(async () => undefined),
    useModel: vi.fn(async () => "{}"),
    getAllActions: () =>
      options.appAction ? ([{ name: "APP" }] as never[]) : ([] as never[]),
  } as unknown as IAgentRuntime;
}

function messageWithText(text: string): Memory {
  return {
    id: MSG,
    entityId: USER,
    roomId: ROOM,
    agentId: AGENT_ID,
    content: { text, source: "discord" },
    createdAt: 1,
  } as unknown as Memory;
}

async function runOp(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: Record<string, unknown>,
) {
  const result = await tasksAction.handler(
    runtime,
    message,
    undefined as unknown as State,
    { parameters },
    undefined,
  );
  if (!result) throw new Error("handler returned no result");
  return result;
}

/** The refusal's redirect instruction is planner-facing. If any fragment of it
 * shows up in `text`/`userFacingText`, the delivery boundary can ship it to
 * chat verbatim (live leak tj-f1e0716132eb14). */
const INTERNAL_ENVELOPE =
  /refused to spawn|do not spawn|candidate task text|WEB_FETCH|auth-walled|embed preview/i;

function expectNoInternalTextInUserFacingFields(result: {
  text?: string;
  userFacingText?: string;
  verifiedUserFacing?: boolean;
}): void {
  expect(String(result.text ?? "")).not.toMatch(INTERNAL_ENVELOPE);
  expect(String(result.userFacingText ?? "")).not.toMatch(INTERNAL_ENVELOPE);
  // A refusal must never carry do-not-paraphrase authority: verified canonical
  // text outranks the evaluator's human reply and ships word-for-word.
  expect(result.verifiedUserFacing).not.toBe(true);
}

describe("TASKS spawn gate: bare link shares never spawn", () => {
  it("spawn_agent with a link-share message and a derived-only task refuses pre-spawn", async () => {
    const { service, spawnSession } = makeFakeAcp();
    const runtime = makeRuntime(service);
    const result = await runOp(runtime, messageWithText(LINK_SHARE_TEXT), {
      action: "spawn_agent",
      agentType: "elizaos",
      // The model derived this from the embed title — not a user instruction.
      task: "agent-messaging-fix",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("LINK_SHARE_NOT_A_TASK");
    // The redirect signal rides in data for the planner — never in the
    // user-facing text channel.
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("LINK_SHARE_NOT_A_TASK");
    expect(String(data.plannerGuidance)).toMatch(/WEB_FETCH/);
    expect(String(data.plannerGuidance)).toMatch(/embed/i);
    // Deliberate pause for direction, not an unresolved failure: the planner
    // may follow the guidance (web read) and let that work own the reply.
    expect(data.awaitingUserInput).toBe(true);
    // The user-visible fields carry only a short human line.
    expectNoInternalTextInUserFacingFields(result);
    expect(String(result.userFacingText ?? "")).not.toHaveLength(0);
    expect(String(result.userFacingText ?? "").length).toBeLessThan(160);
    // FAIL FAST: no ACP session may exist for a refused spawn.
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("create with a link-share message refuses pre-spawn too", async () => {
    const { service, spawnSession } = makeFakeAcp();
    const runtime = makeRuntime(service);
    const result = await runOp(runtime, messageWithText(LINK_SHARE_TEXT), {
      action: "create",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("LINK_SHARE_NOT_A_TASK");
    expectNoInternalTextInUserFacingFields(result);
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("a refused spawn settles as cleanly rejected — no reconciliation noise, no promoted text", async () => {
    const { service } = makeFakeAcp();
    const runtime = makeRuntime(service);
    const result = await runOp(runtime, messageWithText(LINK_SHARE_TEXT), {
      action: "create",
    });

    // The settle wrapper must not promote the failed op's diagnostic text to
    // canonical verified user-facing copy (the exact promotion that shipped
    // the redirect envelope to chat).
    expect(result.verifiedUserFacing).not.toBe(true);
    expect(result.userFacingEffectReceiptIds).toBeUndefined();
    const receipts = result.effectReceipts ?? [];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe("failed");
    expect(
      (receipts[0] as { failure?: { acceptance?: string } }).failure
        ?.acceptance,
    ).toBe("rejected");
    // A pre-flight refusal created nothing: no outcome-unknown bookkeeping.
    const data = result.data as Record<string, unknown>;
    expect(data.outcomeUnknown).toBeUndefined();
    expect(data.reconciliationRequired).toBeUndefined();
  });

  it("an explicit build instruction that includes a URL still spawns", async () => {
    const { service, spawnSession } = makeFakeAcp();
    const runtime = makeRuntime(service);
    const result = await runOp(
      runtime,
      messageWithText(
        "build me a landing page based on this https://example.com/design",
      ),
      {
        action: "spawn_agent",
        agentType: "elizaos",
        task: "build a landing page modeled on https://example.com/design",
      },
    );

    expect(result.success).toBe(true);
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it("a review/audit/investigate work order with a URL still spawns (issue #18108)", async () => {
    // Before the fix, these short-residue messages were misclassified as bare
    // link shares because the verb was absent from the closed English allowlist.
    // They are genuine coding-intent work orders and must reach TASKS.
    const { service, spawnSession } = makeFakeAcp();
    const runtime = makeRuntime(service);

    for (const text of [
      "review this PR https://github.com/elizaOS/eliza/pull/12345",
      "audit this repository https://github.com/elizaOS/eliza",
      "investigate the failure here https://example.com/run",
    ]) {
      const result = await runOp(runtime, messageWithText(text), {
        action: "spawn_agent",
        agentType: "elizaos",
        task: text.replace(/https?:\/\/\S+/, "").trim(),
      });
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    }
    expect(spawnSession).toHaveBeenCalledTimes(3);
  });
});

describe("TASKS spawn gate: empty task prompts refuse pre-spawn", () => {
  it("spawn_agent with no task and an empty message refuses before any session exists", async () => {
    const { service, spawnSession } = makeFakeAcp();
    const runtime = makeRuntime(service);
    const result = await runOp(runtime, messageWithText("   "), {
      action: "spawn_agent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("EMPTY_TASK_PROMPT");
    // Clear, planner-usable refusal in data — not a spawned-then-failed
    // doomed agent, and not an internal envelope in the user channel.
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("EMPTY_TASK_PROMPT");
    expect(String(data.plannerGuidance)).toMatch(/empty/i);
    expectNoInternalTextInUserFacingFields(result);
    expect(spawnSession).not.toHaveBeenCalled();
  });
});

describe("TASKS create gate: new hosted apps use the owned APP workflow", () => {
  it("rejects generic create before spawn when APP is registered", async () => {
    const { service, spawnSession } = makeFakeAcp();
    const runtime = makeRuntime(service, { appAction: true });
    const result = await runOp(
      runtime,
      messageWithText("make me a personal website for nubs"),
      {
        action: "create",
        task: "Build a personal website for Nubs and give the user a live preview.",
        workdir: "/workspaces/nubs-site",
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("HOSTED_APP_NEEDS_APP_BUILDER");
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("HOSTED_APP_NEEDS_APP_BUILDER");
    expect(String(data.plannerGuidance)).toContain("APP");
    expect(String(data.plannerGuidance)).not.toContain("/workspaces/nubs-site");
    expect(result.verifiedUserFacing).not.toBe(true);
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("keeps explicit existing-workdir app work on TASKS", async () => {
    const { service } = makeFakeAcp();
    const runtime = makeRuntime(service, { appAction: true });
    const result = await runOp(
      runtime,
      messageWithText("update the website in my existing repo"),
      {
        action: "create",
        task: "Update the website in the existing repository.",
        workdir: "/tmp",
        lockWorkdir: true,
      },
    );

    // The fake runtime has no project/workspace services, so later routing may
    // reject this fixture. The hosted-app boundary itself must stand aside.
    expect(result.error).not.toBe("HOSTED_APP_NEEDS_APP_BUILDER");
    expect(result.data).not.toMatchObject({
      code: "HOSTED_APP_NEEDS_APP_BUILDER",
    });
  });

  it("keeps explicit raw spawn_agent delegation available", async () => {
    const { service, spawnSession } = makeFakeAcp();
    const runtime = makeRuntime(service, { appAction: true });
    const result = await runOp(
      runtime,
      messageWithText("spawn a coding agent to build a local website"),
      {
        action: "spawn_agent",
        task: "Build a local website.",
      },
    );

    expect(result.success).toBe(true);
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });
});
