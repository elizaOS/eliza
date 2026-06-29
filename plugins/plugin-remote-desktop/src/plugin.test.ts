import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import remoteDesktopPlugin, {
  detectRemoteDesktopBackend,
  REMOTE_DESKTOP_ACTION_NAME,
  remoteDesktopAction,
  startRemoteSession,
} from "./index.js";
import {
  __resetRemoteSessionServiceForTests,
  getRemoteSessionService,
} from "./remote/remote-session-service.js";

// ---------------------------------------------------------------------------
// Minimal runtime stub: the REMOTE_DESKTOP handler only touches the cache
// (via `requireConfirmation`) and `entityId`/`agentId` on the message. The
// session service it dispatches to is the real singleton over a hermetic
// state dir. Anything outside this shape would surface as a TS error the
// moment the production code reached for it.
// ---------------------------------------------------------------------------
function createRuntimeStub(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  const agentId = ("test-agent-" +
    Math.random().toString(36).slice(2, 8)) as UUID;
  return {
    agentId,
    getCache: async <T>(key: string) => (cache.get(key) as T) ?? null,
    setCache: async <T>(key: string, value: T) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
  } as unknown as IAgentRuntime;
}

function ownerMessage(agentId: UUID, text: string): Memory {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}` as UUID,
    entityId: agentId,
    roomId: agentId,
    agentId,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

describe("@elizaos/plugin-remote-desktop", () => {
  it("exports the remote desktop action with the frozen surface", () => {
    expect(remoteDesktopPlugin.name).toBe("remote-desktop");
    expect(remoteDesktopPlugin.actions).toContain(remoteDesktopAction);
    expect(REMOTE_DESKTOP_ACTION_NAME).toBe("REMOTE_DESKTOP");
    expect(remoteDesktopAction.name).toBe("REMOTE_DESKTOP");
    expect(remoteDesktopAction.suppressPostActionContinuation).toBe(true);
    expect(remoteDesktopAction.roleGate).toEqual({ minRole: "OWNER" });
    expect(remoteDesktopAction.similes).toContain("REMOTE_SESSION");
  });
});

describe("detectRemoteDesktopBackend", () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.ELIZA_TEST_REMOTE_DESKTOP_BACKEND;
  });
  afterEach(() => {
    if (prior === undefined) {
      delete process.env.ELIZA_TEST_REMOTE_DESKTOP_BACKEND;
    } else {
      process.env.ELIZA_TEST_REMOTE_DESKTOP_BACKEND = prior;
    }
  });

  it("returns the mock backend when ELIZA_TEST_REMOTE_DESKTOP_BACKEND is truthy", async () => {
    process.env.ELIZA_TEST_REMOTE_DESKTOP_BACKEND = "1";
    expect(await detectRemoteDesktopBackend()).toBe("tailscale-vnc");
  });

  it("honors a `none` preferred backend over any probe", async () => {
    delete process.env.ELIZA_TEST_REMOTE_DESKTOP_BACKEND;
    expect(await detectRemoteDesktopBackend({ preferredBackend: "none" })).toBe(
      "none",
    );
  });
});

describe("startRemoteSession (mock backend)", () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.ELIZA_TEST_REMOTE_DESKTOP_BACKEND;
    process.env.ELIZA_TEST_REMOTE_DESKTOP_BACKEND = "fixture";
  });
  afterEach(() => {
    if (prior === undefined) {
      delete process.env.ELIZA_TEST_REMOTE_DESKTOP_BACKEND;
    } else {
      process.env.ELIZA_TEST_REMOTE_DESKTOP_BACKEND = prior;
    }
  });

  it("opens an active in-process session with a mock ingress URL", async () => {
    const session = await startRemoteSession();
    expect(session.status).toBe("active");
    expect(session.backend).toBe("tailscale-vnc");
    expect(session.mockMode).toBe(true);
    expect(session.accessUrl).toMatch(/^vnc:\/\/127\.0\.0\.1:/);
    expect(session.accessCode).toMatch(/^[0-9]{6}$/);
  });
});

describe("REMOTE_DESKTOP action (local mode, real session service)", () => {
  let priorStateDir: string | undefined;
  let priorLocalMode: string | undefined;

  beforeEach(() => {
    priorStateDir = process.env.ELIZA_STATE_DIR;
    priorLocalMode = process.env.ELIZA_REMOTE_LOCAL_MODE;
    process.env.ELIZA_STATE_DIR = mkdtempSync(
      path.join(tmpdir(), "remote-desktop-plugin-test-"),
    );
    process.env.ELIZA_REMOTE_LOCAL_MODE = "1";
    __resetRemoteSessionServiceForTests();
  });

  afterEach(() => {
    __resetRemoteSessionServiceForTests();
    if (priorStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = priorStateDir;
    }
    if (priorLocalMode === undefined) {
      delete process.env.ELIZA_REMOTE_LOCAL_MODE;
    } else {
      process.env.ELIZA_REMOTE_LOCAL_MODE = priorLocalMode;
    }
  });

  it("start requests confirmation on the first turn even with the LLM confirmed flag set", async () => {
    const runtime = createRuntimeStub();
    const result = await remoteDesktopAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "start a remote session"),
      undefined,
      { parameters: { subaction: "start", confirmed: true } },
      undefined,
      [],
    );
    expect(result?.success).toBe(true);
    const values = result?.values as {
      error?: string;
      requiresConfirmation?: boolean;
    };
    expect(values.error).toBe("CONFIRMATION_REQUIRED");
    expect(values.requiresConfirmation).toBe(true);
  });

  it("start authorizes a session after the user confirms on a follow-up turn", async () => {
    const runtime = createRuntimeStub();
    const pending = await remoteDesktopAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "start a remote session"),
      undefined,
      { parameters: { subaction: "start", confirmed: true } },
      undefined,
      [],
    );
    expect(
      (pending?.values as { requiresConfirmation?: boolean })
        .requiresConfirmation,
    ).toBe(true);
    // Second turn: the user replies "yes". In local mode without a data plane,
    // ingressUrl is null and the action surfaces DATA_PLANE_NOT_CONFIGURED —
    // the real, expected failure shape carrying the sessionId.
    const result = await remoteDesktopAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "yes"),
      undefined,
      { parameters: { subaction: "start", confirmed: true } },
      undefined,
      [],
    );
    const values = result?.values as {
      error?: string;
      sessionId?: string;
      localMode?: boolean;
    };
    expect(values.localMode).toBe(true);
    expect(typeof values.sessionId).toBe("string");
    expect(values.sessionId?.length ?? 0).toBeGreaterThan(0);
    expect(values.error).toBe("DATA_PLANE_NOT_CONFIGURED");
  });

  it("list enumerates active sessions started via the service", async () => {
    const runtime = createRuntimeStub();
    const service = getRemoteSessionService();
    await service.startSession({
      requesterIdentity: "test-requester",
      confirmed: true,
    });

    const result = await remoteDesktopAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "list remote sessions"),
      undefined,
      { parameters: { subaction: "list" } },
      undefined,
      [],
    );
    expect(result?.success).toBe(true);
    const data = result?.data as {
      sessions?: Array<{ id: string; status: string }>;
    };
    expect(data.sessions?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(data.sessions?.[0]?.status).toBe("active");
  });

  it("revoke flips the session to revoked and removes it from list", async () => {
    const runtime = createRuntimeStub();
    const service = getRemoteSessionService();
    const seeded = await service.startSession({
      requesterIdentity: "test-requester",
      confirmed: true,
    });

    const revoke = await remoteDesktopAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "revoke"),
      undefined,
      { parameters: { subaction: "revoke", sessionId: seeded.sessionId } },
      undefined,
      [],
    );
    expect(revoke?.success).toBe(true);

    const after = await remoteDesktopAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "list"),
      undefined,
      { parameters: { subaction: "list" } },
      undefined,
      [],
    );
    const sessions = (
      after?.data as { sessions?: Array<{ id: string; status: string }> }
    ).sessions;
    expect(sessions?.find((s) => s.id === seeded.sessionId)).toBeUndefined();
  });

  it("revoke surfaces SESSION_NOT_FOUND for an unknown id", async () => {
    const runtime = createRuntimeStub();
    const result = await remoteDesktopAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "revoke"),
      undefined,
      { parameters: { subaction: "revoke", sessionId: "non-existent" } },
      undefined,
      [],
    );
    expect(result?.success).toBe(false);
    expect((result?.values as { error?: string }).error).toBe(
      "SESSION_NOT_FOUND",
    );
  });

  it("status without a sessionId is rejected by the arg resolver before dispatch", async () => {
    const runtime = createRuntimeStub();
    const result = await remoteDesktopAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "status"),
      undefined,
      { parameters: { subaction: "status" } },
      undefined,
      [],
    );
    expect(result?.success).toBe(false);
    const values = result?.values as { error?: string; missing?: string[] };
    expect(values.error).toBe("MISSING_REMOTE_DESKTOP_ARGUMENTS");
    expect(values.missing?.length ?? 0).toBeGreaterThan(0);
  });
});
