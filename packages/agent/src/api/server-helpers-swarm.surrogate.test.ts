/** Surrogate safety for swarm task relay preview — exercises production seam in server-helpers-swarm.ts. */

import { describe, expect, test, vi } from "vitest";

vi.mock("@elizaos/plugin-agent-orchestrator", () => ({
  sanitizeCompletionRelay: (s: string) => s,
}));

vi.mock("./chat-routes.ts", () => ({
  generateChatResponse: async () => ({ text: "" }),
}));

vi.mock("./client-chat-admin.ts", () => ({
  resolveClientChatAdminEntityId: () => "mock-admin",
}));

vi.mock("./parse-action-block.ts", () => ({
  parseActionBlock: () => null,
  stripActionBlockFromDisplay: (s: string) => s,
}));

vi.mock("./server-helpers.ts", () => ({
  resolveAppUserName: () => "test",
}));

vi.mock("./task-agent-message-routing.ts", () => ({
  routeTaskAgentTextToConnector: async () => false,
}));

import {
  buildTaskResultLine,
  formatSwarmTaskPreview,
  SWARM_TASK_PREVIEW_CAP,
} from "./server-helpers-swarm.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

describe("swarm task relay preview surrogate safety — production seam", () => {
  test("helper backs off astral at 140 boundary via production helper", () => {
    const fox = "🦊";
    const line = `${"a".repeat(139)}${fox}${"b".repeat(50)}`;
    const out = formatSwarmTaskPreview(line);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("a".repeat(139));
    expect(out.length).toBe(139);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  test("helper keeps fitting astral at 138+fox=140 intact", () => {
    const fox = "🦊";
    const line = `${"a".repeat(138)}${fox}`;
    const out = formatSwarmTaskPreview(line);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(line);
    expect(out.includes(fox)).toBe(true);
    expect(out.length).toBe(140);
  });

  test("helper sanitizes lone high surrogate", () => {
    const bad = `Swarm ${String.fromCharCode(0xd800)} task ${"x".repeat(200)}`;
    const out = formatSwarmTaskPreview(bad);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\ud800")).toBe(false);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  test("helper sweep around 140 cap all stay well-formed and capped", () => {
    const fox = "🦊";
    for (let offset = -5; offset <= 5; offset++) {
      const n = SWARM_TASK_PREVIEW_CAP + offset;
      const line = `${"a".repeat(Math.max(0, n))}${fox}${"b".repeat(20)}`;
      const out = formatSwarmTaskPreview(line);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(SWARM_TASK_PREVIEW_CAP);
      expect(() => JSON.stringify({ out })).not.toThrow();
    }
  });

  test("pre-completion ask path (stopped) backs off split surrogate via buildTaskResultLine", async () => {
    const fox = "🦊";
    const poisoned = `${"a".repeat(139)}${fox}${"b".repeat(50)}`;
    const out = await buildTaskResultLine({
      label: undefined,
      originalTask: poisoned,
      completionSummary: "",
      validationSummary: undefined,
      status: "stopped",
      agentType: "codex",
      workdir: undefined,
    });
    // ask should be truncated preview (backs off to 139) before suffix
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(
      SWARM_TASK_PREVIEW_CAP + " — stopped before completion.".length,
    );
    expect(out.startsWith("a".repeat(139))).toBe(true);
    expect(out).not.toContain("\ud83e");
    expect(out).not.toContain("\udc8a");
    expect(out.endsWith(" — stopped before completion.")).toBe(true);
    expect(() => JSON.stringify({ out })).not.toThrow();
    // mutation probe: naive slice would leave lone high surrogate and be not well-formed
    // so this expectation proves the production seam is exercised
    expect(out.includes(fox)).toBe(false);
  });

  test("pre-completion ask path keeps fitting emoji when within cap", async () => {
    const fox = "🦊";
    const poisoned = `${"a".repeat(138)}${fox}`;
    const out = await buildTaskResultLine({
      label: undefined,
      originalTask: poisoned,
      completionSummary: "",
      validationSummary: undefined,
      status: "errored",
      agentType: "codex",
      workdir: undefined,
    });
    expect(isWellFormed(out)).toBe(true);
    expect(out.startsWith(poisoned)).toBe(true);
    expect(out.includes(fox)).toBe(true);
    expect(out.endsWith(" — errored before completion.")).toBe(true);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  test("pre-completion path sanitizes lone surrogate in task line", async () => {
    const bad = `Swarm ${String.fromCharCode(0xd800)} task ${"x".repeat(200)}`;
    const out = await buildTaskResultLine({
      label: undefined,
      originalTask: bad,
      completionSummary: "",
      validationSummary: undefined,
      status: "stopped",
      agentType: "codex",
      workdir: undefined,
    });
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\ud800")).toBe(false);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  test("normal completion taskLine path backs off split surrogate via buildTaskResultLine", async () => {
    const fox = "🦊";
    const poisoned = `${"a".repeat(139)}${fox}${"b".repeat(50)}\nsecond line ignored`;
    const out = await buildTaskResultLine({
      label: undefined,
      originalTask: poisoned,
      completionSummary: "",
      validationSummary: undefined,
      status: "completed",
      agentType: "codex",
      workdir: undefined,
    });
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("a".repeat(139));
    expect(out.length).toBe(139);
    expect(out.includes(fox)).toBe(false);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  test("normal completion taskLine keeps fitting emoji when within cap", async () => {
    const fox = "🦊";
    const poisoned = `${"a".repeat(138)}${fox}`;
    const out = await buildTaskResultLine({
      label: undefined,
      originalTask: poisoned,
      completionSummary: "",
      validationSummary: undefined,
      status: "completed",
      agentType: "codex",
      workdir: undefined,
    });
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(poisoned);
    expect(out.includes(fox)).toBe(true);
    expect(out.length).toBe(140);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  test("normal completion taskLine sanitizes lone surrogate and caps at 140", async () => {
    const bad = `Swarm ${String.fromCharCode(0xd800)} task ${"x".repeat(200)}`;
    const out = await buildTaskResultLine({
      label: undefined,
      originalTask: bad,
      completionSummary: "",
      validationSummary: undefined,
      status: "completed",
      agentType: "codex",
      workdir: undefined,
    });
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\ud800")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(140);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  test("sweep both branches around 140 cap stay well-formed", async () => {
    const fox = "🦊";
    for (let offset = -5; offset <= 5; offset++) {
      const n = SWARM_TASK_PREVIEW_CAP + offset;
      const line = `${"a".repeat(Math.max(0, n))}${fox}${"b".repeat(20)}`;
      const pre = await buildTaskResultLine({
        label: undefined,
        originalTask: line,
        completionSummary: "",
        validationSummary: undefined,
        status: "stopped",
        agentType: "codex",
        workdir: undefined,
      });
      const completed = await buildTaskResultLine({
        label: undefined,
        originalTask: line,
        completionSummary: "",
        validationSummary: undefined,
        status: "completed",
        agentType: "codex",
        workdir: undefined,
      });
      expect(isWellFormed(pre)).toBe(true);
      expect(isWellFormed(completed)).toBe(true);
      expect(() => JSON.stringify({ pre, completed })).not.toThrow();
      expect(completed.length).toBeLessThanOrEqual(140);
    }
  });
});
