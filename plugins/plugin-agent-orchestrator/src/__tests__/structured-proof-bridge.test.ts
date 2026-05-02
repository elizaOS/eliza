/**
 * Tests for the structured-proof bridge.
 *
 * The bridge listens to PTY session output and, when the child emits a
 * `APP_CREATE_DONE {...}` or `PLUGIN_CREATE_DONE {...}` line, persists the
 * structured claim to the owning task's session metadata via the task
 * registry's `updateSession({ metadata })` API.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetStructuredProofBridge,
  installStructuredProofBridge,
  parseStructuredProofDirective,
} from "../services/structured-proof-bridge.js";

type EventCallback = (sessionId: string, event: string, data: unknown) => void;

interface FakePtyService {
  emit: (sessionId: string, event: string, data: unknown) => void;
  onSessionEvent: (cb: EventCallback) => () => void;
  sendToSession: ReturnType<typeof vi.fn>;
  coordinator: null;
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
    coordinator: null,
  };
}

function createRuntime(): IAgentRuntime {
  return {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getSetting: () => undefined,
    getService: () => null,
  } as unknown as IAgentRuntime;
}

function createFakeRegistry(): {
  updateSession: ReturnType<typeof vi.fn>;
} {
  return {
    updateSession: vi.fn(async () => undefined),
  };
}

describe("parseStructuredProofDirective", () => {
  it("parses a valid APP_CREATE_DONE line", () => {
    const out = parseStructuredProofDirective(
      'APP_CREATE_DONE {"appName":"foo","files":["src/plugin.ts","package.json"],"tests":{"passed":5,"failed":0},"lint":"ok","typecheck":"ok","description":"demo"}',
    );
    expect(out?.ok).toBe(true);
    if (out?.ok) {
      expect(out.parsed.kind).toBe("APP_CREATE_DONE");
      expect(out.parsed.claim.appName).toBe("foo");
      expect(out.parsed.claim.files).toEqual(["src/plugin.ts", "package.json"]);
      expect(out.parsed.claim.tests).toEqual({ passed: 5, failed: 0 });
      expect(out.parsed.claim.lint).toBe("ok");
      expect(out.parsed.claim.typecheck).toBe("ok");
      expect(out.parsed.claim.extra).toEqual({ description: "demo" });
    }
  });

  it("parses a valid PLUGIN_CREATE_DONE line embedded in surrounding output", () => {
    const text = [
      "Working on it...",
      'PLUGIN_CREATE_DONE {"pluginName":"plugin-bar","files":["src/index.ts"],"tests":{"passed":3,"failed":0},"lint":"ok","typecheck":"ok"}',
      "Done.",
    ].join("\n");
    const out = parseStructuredProofDirective(text);
    expect(out?.ok).toBe(true);
    if (out?.ok) {
      expect(out.parsed.kind).toBe("PLUGIN_CREATE_DONE");
      expect(out.parsed.claim.pluginName).toBe("plugin-bar");
      expect(out.parsed.claim.tests.passed).toBe(3);
    }
  });

  it("returns null when no directive is present", () => {
    expect(parseStructuredProofDirective("just prose, no sentinel")).toBeNull();
    expect(parseStructuredProofDirective("")).toBeNull();
  });

  it("returns ok=false when the JSON body is not parseable", () => {
    const out = parseStructuredProofDirective(
      "APP_CREATE_DONE {not valid json}",
    );
    expect(out?.ok).toBe(false);
    if (out && out.ok === false) {
      expect(out.reason).toContain("JSON parse failed");
    }
  });

  it("returns ok=false for valid JSON but missing required fields", () => {
    const out = parseStructuredProofDirective(
      'APP_CREATE_DONE {"appName":"foo"}',
    );
    expect(out?.ok).toBe(false);
    if (out && out.ok === false) {
      expect(out.reason).toContain("'files'");
    }
  });

  it("returns ok=false when files is not a string array", () => {
    const out = parseStructuredProofDirective(
      'APP_CREATE_DONE {"appName":"foo","files":"index.ts","tests":{"passed":0,"failed":0},"lint":"ok","typecheck":"ok"}',
    );
    expect(out?.ok).toBe(false);
  });

  it("rejects the legacy name/testsPassed/lintClean proof shape", () => {
    const out = parseStructuredProofDirective(
      'APP_CREATE_DONE {"name":"foo","files":["a.ts"],"testsPassed":1,"lintClean":true}',
    );
    expect(out?.ok).toBe(false);
    if (out && out.ok === false) {
      expect(out.reason).toContain("legacy field 'name'");
    }
  });

  it("rejects non-zero failed tests and non-ok lint/typecheck statuses", () => {
    const failedTests = parseStructuredProofDirective(
      'APP_CREATE_DONE {"appName":"foo","files":["a.ts"],"tests":{"passed":1,"failed":1},"lint":"ok","typecheck":"ok"}',
    );
    expect(failedTests?.ok).toBe(false);
    if (failedTests && failedTests.ok === false) {
      expect(failedTests.reason).toContain("'tests.failed' must be 0");
    }

    const dirtyLint = parseStructuredProofDirective(
      'PLUGIN_CREATE_DONE {"pluginName":"plugin-bar","files":["a.ts"],"tests":{"passed":1,"failed":0},"lint":"fail","typecheck":"ok"}',
    );
    expect(dirtyLint?.ok).toBe(false);

    const dirtyTypecheck = parseStructuredProofDirective(
      'PLUGIN_CREATE_DONE {"pluginName":"plugin-bar","files":["a.ts"],"tests":{"passed":1,"failed":0},"lint":"ok","typecheck":"fail"}',
    );
    expect(dirtyTypecheck?.ok).toBe(false);
  });

  it("rejects the wrong canonical name field for the directive kind", () => {
    const out = parseStructuredProofDirective(
      'APP_CREATE_DONE {"pluginName":"plugin-bar","files":["a.ts"],"tests":{"passed":1,"failed":0},"lint":"ok","typecheck":"ok"}',
    );
    expect(out?.ok).toBe(false);
    if (out && out.ok === false) {
      expect(out.reason).toContain("'pluginName' is not valid");
    }
  });

  it("preserves unknown fields under `extra`", () => {
    const out = parseStructuredProofDirective(
      'APP_CREATE_DONE {"appName":"foo","files":["a.ts"],"tests":{"passed":1,"failed":0},"lint":"ok","typecheck":"ok","customField":42}',
    );
    expect(out?.ok).toBe(true);
    if (out?.ok) {
      expect(out.parsed.claim.extra).toEqual({ customField: 42 });
    }
  });
});

describe("installStructuredProofBridge", () => {
  beforeEach(() => {
    _resetStructuredProofBridge();
  });

  it("persists a valid APP_CREATE_DONE claim to the task registry", async () => {
    const pty = createFakePty();
    const registry = createFakeRegistry();
    const runtime = createRuntime();

    installStructuredProofBridge({
      runtime,
      ptyService: pty as never,
      taskRegistry: registry as never,
    });

    pty.emit("session-1", "task_complete", {
      response:
        'Created files\nAPP_CREATE_DONE {"appName":"demo-app","files":["src/plugin.ts","package.json"],"tests":{"passed":2,"failed":0},"lint":"ok","typecheck":"ok"}\n',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(registry.updateSession).toHaveBeenCalledTimes(1);
    const [sessionId, patch] = registry.updateSession.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(patch).toMatchObject({
      metadata: {
        structuredProof: {
          kind: "APP_CREATE_DONE",
          appName: "demo-app",
          files: ["src/plugin.ts", "package.json"],
          tests: { passed: 2, failed: 0 },
          lint: "ok",
          typecheck: "ok",
          recordedAt: expect.any(Number),
        },
      },
    });
    const proof = patch.metadata.structuredProof;
    expect(proof).not.toHaveProperty("name");
    expect(proof).not.toHaveProperty("testsPassed");
    expect(proof).not.toHaveProperty("lintClean");

    expect(pty.sendToSession).toHaveBeenCalledTimes(1);
    const [ackSession, ackText] = pty.sendToSession.mock.calls[0];
    expect(ackSession).toBe("session-1");
    expect(ackText).toContain("structured proof recorded");
    expect(ackText).toContain("APP_CREATE_DONE");
    expect(ackText).toContain("demo-app");
  });

  it("logs and skips a malformed JSON sentinel without crashing", async () => {
    const pty = createFakePty();
    const registry = createFakeRegistry();
    const runtime = createRuntime();
    const warn = vi.fn();
    (runtime as unknown as { logger: { warn: typeof warn } }).logger.warn =
      warn;

    installStructuredProofBridge({
      runtime,
      ptyService: pty as never,
      taskRegistry: registry as never,
    });

    pty.emit("session-bad", "task_complete", {
      response: 'APP_CREATE_DONE {"appName":"foo"} ', // missing required fields
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(registry.updateSession).not.toHaveBeenCalled();
    expect(pty.sendToSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("ignores duplicate proofs for the same session", async () => {
    const pty = createFakePty();
    const registry = createFakeRegistry();
    const runtime = createRuntime();

    installStructuredProofBridge({
      runtime,
      ptyService: pty as never,
      taskRegistry: registry as never,
    });

    const firstClaim =
      'APP_CREATE_DONE {"appName":"first","files":["a.ts"],"tests":{"passed":1,"failed":0},"lint":"ok","typecheck":"ok"}';
    const secondClaim =
      'APP_CREATE_DONE {"appName":"second","files":["b.ts"],"tests":{"passed":2,"failed":0},"lint":"ok","typecheck":"ok"}';

    pty.emit("session-dup", "task_complete", { response: firstClaim });
    await new Promise((resolve) => setImmediate(resolve));

    pty.emit("session-dup", "task_complete", { response: secondClaim });
    await new Promise((resolve) => setImmediate(resolve));

    // Only the first proof persists.
    expect(registry.updateSession).toHaveBeenCalledTimes(1);
    const [, firstPatch] = registry.updateSession.mock.calls[0];
    expect(
      (firstPatch as { metadata: { structuredProof: { appName: string } } })
        .metadata.structuredProof.appName,
    ).toBe("first");

    // The duplicate still gets an explicit ack so the agent knows it
    // wasn't lost — just that the orchestrator is keeping the first.
    expect(pty.sendToSession).toHaveBeenCalledTimes(2);
    const [, secondAck] = pty.sendToSession.mock.calls[1];
    expect(secondAck).toContain("duplicate ignored");
  });

  it("ignores events with no structured-proof sentinel", async () => {
    const pty = createFakePty();
    const registry = createFakeRegistry();
    const runtime = createRuntime();

    installStructuredProofBridge({
      runtime,
      ptyService: pty as never,
      taskRegistry: registry as never,
    });

    pty.emit("session-noop", "task_complete", {
      response: "Nothing to declare here.",
    });
    pty.emit("session-noop", "blocked", {
      response:
        'APP_CREATE_DONE {"appName":"x","files":[],"tests":{"passed":0,"failed":0},"lint":"ok","typecheck":"ok"}', // wrong event type
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(registry.updateSession).not.toHaveBeenCalled();
  });
});
