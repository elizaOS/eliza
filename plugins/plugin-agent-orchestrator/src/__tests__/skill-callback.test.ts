/**
 * Tests for the child→parent USE_SKILL callback bridge.
 *
 * The bridge listens to PTY session events, parses USE_SKILL directives in
 * child output, dispatches to the parent's USE_SKILL action, and sends the
 * result back to the same session via ptyService.sendToSession.
 */

import type { Action, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  createSkillSessionAllowList,
  installSkillCallbackBridge,
  parseUseSkillDirective,
} from "../services/skill-callback-bridge.js";
import { LIFEOPS_CONTEXT_BROKER_SLUG } from "../services/skill-lifeops-context-broker.js";

type EventCallback = (sessionId: string, event: string, data: unknown) => void;

interface FakePtyService {
  emit: (sessionId: string, event: string, data: unknown) => void;
  onSessionEvent: (cb: EventCallback) => () => void;
  sendToSession: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
}

function createFakePty(): FakePtyService {
  const callbacks: EventCallback[] = [];
  return {
    emit: (sessionId, event, data) => {
      for (const cb of callbacks) cb(sessionId, event, data);
    },
    onSessionEvent: (cb) => {
      callbacks.push(cb);
      return () => {
        const idx = callbacks.indexOf(cb);
        if (idx !== -1) callbacks.splice(idx, 1);
      };
    },
    sendToSession: vi.fn(async () => undefined),
    getSession: vi.fn(() => undefined),
  };
}

interface RuntimeOpts {
  useSkillHandler?: Action["handler"];
  callbackEnabled?: boolean;
}

function createRuntime(opts: RuntimeOpts = {}): IAgentRuntime {
  const useSkillHandler =
    opts.useSkillHandler ??
    (async (_runtime, _message, _state, options, callback) => {
      const slug = (options as { slug?: string } | undefined)?.slug ?? "?";
      const text = `**${slug}** ran successfully with no output.`;
      if (callback) await callback({ text });
      return { success: true, text, data: { slug, mode: "guidance" as const } };
    });

  const useSkillAction: Action = {
    name: "USE_SKILL",
    similes: ["INVOKE_SKILL"],
    description: "test stub",
    examples: [],
    validate: async () => true,
    handler: useSkillHandler,
  };

  const settings: Record<string, string | undefined> = {};
  if (opts.callbackEnabled === false) {
    settings.ELIZA_ENABLE_CHILD_SKILL_CALLBACK = "0";
  }

  return {
    actions: [useSkillAction],
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getSetting: (key: string) => settings[key],
    getService: () => null,
  } as unknown as IAgentRuntime;
}

describe("parseUseSkillDirective", () => {
  it("matches a bare USE_SKILL line with no args", () => {
    const parsed = parseUseSkillDirective("USE_SKILL pdf-tools");
    expect(parsed).toEqual({ slug: "pdf-tools", args: undefined });
  });

  it("parses a JSON object as args", () => {
    const parsed = parseUseSkillDirective(
      'USE_SKILL pdf-tools {"file": "report.pdf", "rotate": 90}',
    );
    expect(parsed?.slug).toBe("pdf-tools");
    expect(parsed?.args).toEqual({ file: "report.pdf", rotate: 90 });
  });

  it("parses a JSON array as args", () => {
    const parsed = parseUseSkillDirective(
      'USE_SKILL playwright-runner ["e2e", "--headed"]',
    );
    expect(parsed?.args).toEqual(["e2e", "--headed"]);
  });

  it("falls back to the raw string when args are not valid JSON", () => {
    const parsed = parseUseSkillDirective(
      "USE_SKILL weather {something not json}",
    );
    expect(parsed?.slug).toBe("weather");
    // Bridge keeps the raw payload so the action can decide how to coerce it.
    expect(typeof parsed?.args).toBe("string");
  });

  it("matches the directive when surrounded by other agent output", () => {
    const text =
      'Thinking about the task...\nUSE_SKILL github-issues {"action": "list"}\nDone.';
    const parsed = parseUseSkillDirective(text);
    expect(parsed?.slug).toBe("github-issues");
    expect(parsed?.args).toEqual({ action: "list" });
  });

  it("returns null when no directive is present", () => {
    expect(
      parseUseSkillDirective("Just some prose with no directive."),
    ).toBeNull();
    expect(parseUseSkillDirective("")).toBeNull();
  });

  it("requires a slug-shaped identifier", () => {
    expect(parseUseSkillDirective("USE_SKILL Not_A_Slug")).toBeNull();
    expect(parseUseSkillDirective("USE_SKILL UPPER")).toBeNull();
  });
});

describe("installSkillCallbackBridge", () => {
  it("dispatches USE_SKILL to the parent action and pipes the result back to the child session", async () => {
    const pty = createFakePty();
    const handler = vi.fn(async (_r, _m, _s, options, callback) => {
      const slug = (options as { slug: string }).slug;
      const text = `result for ${slug}`;
      if (callback) await callback({ text });
      return { success: true, text, data: { slug, mode: "guidance" as const } };
    });
    const runtime = createRuntime({ useSkillHandler: handler });

    installSkillCallbackBridge({ runtime, ptyService: pty as never });

    pty.emit("session-1", "task_complete", {
      response: 'Working on it.\nUSE_SKILL github-issues {"action": "list"}',
    });

    // Bridge dispatch is async; flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).toHaveBeenCalledTimes(1);
    const callArgs = handler.mock.calls[0];
    expect(callArgs?.[3]).toEqual({
      slug: "github-issues",
      args: { action: "list" },
    });

    expect(pty.sendToSession).toHaveBeenCalledTimes(1);
    const [sessionId, replyText] = pty.sendToSession.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(replyText).toContain(
      "--- USE_SKILL response (github-issues, ok) ---",
    );
    expect(replyText).toContain("result for github-issues");
  });

  it("does not dispatch when ELIZA_ENABLE_CHILD_SKILL_CALLBACK=0", async () => {
    const pty = createFakePty();
    const handler = vi.fn();
    const runtime = createRuntime({
      useSkillHandler: handler as never,
      callbackEnabled: false,
    });

    installSkillCallbackBridge({ runtime, ptyService: pty as never });
    pty.emit("session-x", "task_complete", {
      response: "USE_SKILL pdf-tools",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).not.toHaveBeenCalled();
    expect(pty.sendToSession).not.toHaveBeenCalled();
  });

  it("ignores events with no USE_SKILL directive", async () => {
    const pty = createFakePty();
    const handler = vi.fn();
    const runtime = createRuntime({ useSkillHandler: handler as never });

    installSkillCallbackBridge({ runtime, ptyService: pty as never });
    pty.emit("session-y", "task_complete", {
      response: "Just a normal response with no skill request.",
    });
    pty.emit("session-y", "blocked", {
      response: "USE_SKILL pdf-tools", // wrong event type → still ignored
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).not.toHaveBeenCalled();
    expect(pty.sendToSession).not.toHaveBeenCalled();
  });

  it("surfaces handler failures in the reply payload", async () => {
    const pty = createFakePty();
    const handler = vi.fn(async (_r, _m, _s, options, callback) => {
      const slug = (options as { slug: string }).slug;
      const text = `Skill \`${slug}\` is disabled.`;
      if (callback) await callback({ text });
      return { success: false, text, error: new Error(text) };
    });
    const runtime = createRuntime({ useSkillHandler: handler as never });

    installSkillCallbackBridge({ runtime, ptyService: pty as never });
    pty.emit("session-z", "task_complete", {
      response: "USE_SKILL weather",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(pty.sendToSession).toHaveBeenCalledTimes(1);
    const [, replyText] = pty.sendToSession.mock.calls[0];
    expect(replyText).toContain("--- USE_SKILL response (weather, error) ---");
    expect(replyText).toContain("disabled");
  });

  it("rejects a USE_SKILL directive whose slug is not on the session's allow-list", async () => {
    const pty = createFakePty();
    const handler = vi.fn();
    const runtime = createRuntime({ useSkillHandler: handler as never });
    const allowList = createSkillSessionAllowList();
    allowList.register("session-allow", ["pdf-tools", "github-issues"]);

    installSkillCallbackBridge({
      runtime,
      ptyService: pty as never,
      sessionAllowList: allowList,
    });

    pty.emit("session-allow", "task_complete", {
      response: "USE_SKILL weather", // not on allow-list
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).not.toHaveBeenCalled();
    expect(pty.sendToSession).toHaveBeenCalledTimes(1);
    const [sessionId, replyText] = pty.sendToSession.mock.calls[0];
    expect(sessionId).toBe("session-allow");
    expect(replyText).toContain("--- USE_SKILL response (weather, error) ---");
    expect(replyText).toContain("not on this task's allow-list");
    expect(replyText).toContain("`pdf-tools`");
    expect(replyText).toContain("`github-issues`");
  });

  it("permits a USE_SKILL directive whose slug is on the session's allow-list", async () => {
    const pty = createFakePty();
    const handler = vi.fn(async (_r, _m, _s, options, callback) => {
      const slug = (options as { slug: string }).slug;
      const text = `ran ${slug}`;
      if (callback) await callback({ text });
      return { success: true, text, data: { slug, mode: "guidance" as const } };
    });
    const runtime = createRuntime({ useSkillHandler: handler });
    const allowList = createSkillSessionAllowList();
    allowList.register("session-allow", ["pdf-tools"]);

    installSkillCallbackBridge({
      runtime,
      ptyService: pty as never,
      sessionAllowList: allowList,
    });

    pty.emit("session-allow", "task_complete", {
      response: "USE_SKILL pdf-tools",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).toHaveBeenCalledTimes(1);
    const [, replyText] = pty.sendToSession.mock.calls[0];
    expect(replyText).toContain("--- USE_SKILL response (pdf-tools, ok) ---");
  });

  it("falls back to permissive behavior when no allow-list entry is registered", async () => {
    const pty = createFakePty();
    const handler = vi.fn(async (_r, _m, _s, _options, callback) => {
      if (callback) await callback({ text: "ok" });
      return {
        success: true,
        text: "ok",
        data: { slug: "weather", mode: "guidance" as const },
      };
    });
    const runtime = createRuntime({ useSkillHandler: handler });
    // Allow-list exists but no entry for this session.
    const allowList = createSkillSessionAllowList();

    installSkillCallbackBridge({
      runtime,
      ptyService: pty as never,
      sessionAllowList: allowList,
    });

    pty.emit("session-none", "task_complete", {
      response: "USE_SKILL weather",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("routes allow-listed lifeops-context requests through the broker with args and result", async () => {
    const pty = createFakePty();
    pty.getSession.mockReturnValue({
      id: "session-lifeops",
      name: "lifeops",
      agentType: "codex",
      workdir: "/tmp",
      status: "running",
      createdAt: new Date("2026-04-26T00:00:00Z"),
      lastActivityAt: new Date("2026-04-26T00:00:00Z"),
      metadata: {
        userId: "owner-user",
        roomId: "owner-room",
      },
    });
    const useSkillHandler = vi.fn();
    const ownerInboxHandler = vi.fn(async (_r, _m, _s, options) => ({
      success: true,
      text: `owner inbox query: ${
        ((options as { parameters?: Record<string, unknown> }).parameters
          ?.query as string | undefined) ?? ""
      }`,
      data: { ok: true },
    }));
    const runtime = {
      ...createRuntime({ useSkillHandler: useSkillHandler as never }),
      actions: [
        {
          name: "USE_SKILL",
          similes: ["INVOKE_SKILL"],
          description: "test stub",
          examples: [],
          validate: async () => true,
          handler: useSkillHandler,
        },
        {
          name: "OWNER_INBOX",
          description: "owner inbox",
          examples: [],
          validate: async () => true,
          handler: ownerInboxHandler,
        },
      ],
    } as unknown as IAgentRuntime;
    const allowList = createSkillSessionAllowList();
    allowList.register("session-lifeops", [LIFEOPS_CONTEXT_BROKER_SLUG]);

    installSkillCallbackBridge({
      runtime,
      ptyService: pty as never,
      sessionAllowList: allowList,
    });

    pty.emit("session-lifeops", "task_complete", {
      response:
        'USE_SKILL lifeops-context {"category":"email","query":"launch invoice","limit":5}',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(useSkillHandler).not.toHaveBeenCalled();
    expect(ownerInboxHandler).toHaveBeenCalledTimes(1);
    expect(
      (
        ownerInboxHandler.mock.calls[0]?.[3] as {
          parameters?: Record<string, unknown>;
        }
      ).parameters,
    ).toMatchObject({
      subaction: "search",
      channel: "gmail",
      query: "launch invoice",
    });
    const [sessionId, replyText] = pty.sendToSession.mock.calls[0];
    expect(sessionId).toBe("session-lifeops");
    expect(replyText).toContain(
      "--- USE_SKILL response (lifeops-context, ok) ---",
    );
    expect(replyText).toContain("owner inbox query: launch invoice");
  });

  it("rejects lifeops-context when no session allow-list grant exists", async () => {
    const pty = createFakePty();
    const useSkillHandler = vi.fn();
    const runtime = createRuntime({
      useSkillHandler: useSkillHandler as never,
    });
    const allowList = createSkillSessionAllowList();

    installSkillCallbackBridge({
      runtime,
      ptyService: pty as never,
      sessionAllowList: allowList,
    });

    pty.emit("session-none", "task_complete", {
      response: 'USE_SKILL lifeops-context {"category":"email"}',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(useSkillHandler).not.toHaveBeenCalled();
    expect(pty.sendToSession).toHaveBeenCalledTimes(1);
    const [, replyText] = pty.sendToSession.mock.calls[0];
    expect(replyText).toContain(
      "--- USE_SKILL response (lifeops-context, error) ---",
    );
    expect(replyText).toContain(
      "only available when the parent explicitly recommends it",
    );
  });

  it("reports the scratchpad app-level broker gap when no scratchpad action is available", async () => {
    const pty = createFakePty();
    const runtime = createRuntime();
    const allowList = createSkillSessionAllowList();
    allowList.register("session-lifeops", [LIFEOPS_CONTEXT_BROKER_SLUG]);

    installSkillCallbackBridge({
      runtime,
      ptyService: pty as never,
      sessionAllowList: allowList,
    });

    pty.emit("session-lifeops", "task_complete", {
      response:
        'USE_SKILL lifeops-context {"category":"scratchpad","query":"project notes"}',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(pty.sendToSession).toHaveBeenCalledTimes(1);
    const [, replyText] = pty.sendToSession.mock.calls[0];
    expect(replyText).toContain("/api/knowledge/scratchpad/search");
    expect(replyText).toContain("SCRATCHPAD_SEARCH");
  });

  it("stays inert when the runtime does not register a USE_SKILL action", async () => {
    const pty = createFakePty();
    const runtime = {
      actions: [],
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      getSetting: () => undefined,
      getService: () => null,
    } as unknown as IAgentRuntime;

    installSkillCallbackBridge({ runtime, ptyService: pty as never });
    pty.emit("session-q", "task_complete", { response: "USE_SKILL pdf-tools" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(pty.sendToSession).not.toHaveBeenCalled();
  });
});
