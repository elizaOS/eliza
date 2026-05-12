/**
 * `REMOTE_DESKTOP` action integration test.
 *
 * Closes the gap from `docs/audits/lifeops-2026-05-09/03-coverage-gap-matrix.md`
 * line 445 + line 98 (#71): `remoteDesktopAction` has no test, scenarios
 * exist but no integration coverage of the handler-level contract.
 *
 * Drives the action handler through the real `RemoteSessionService` singleton
 * with a hermetic state dir (so the JSON ledger lands in a tmpdir) and
 * `ELIZA_REMOTE_LOCAL_MODE=1` so we exercise the pairing-code-bypass path
 * without needing the cloud tunnel infrastructure.
 *
 * Asserts:
 *   - `start` without `confirmed:true` returns CONFIRMATION_REQUIRED
 *   - `start` with `confirmed:true` in local mode authorizes a session
 *     (ingress may be null when no data plane is configured — that's the
 *      DATA_PLANE_NOT_CONFIGURED failure path the action surfaces verbatim)
 *   - `list` enumerates the active session
 *   - `revoke` clears the session
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __resetRemoteSessionServiceForTests,
  getRemoteSessionService,
} from "../src/remote/remote-session-service.ts";
import type { Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remoteDesktopAction } from "../src/actions/remote-desktop.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

let priorStateDir: string | undefined;
let priorLocalMode: string | undefined;

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

describe("REMOTE_DESKTOP integration (local mode)", () => {
  beforeEach(() => {
    priorStateDir = process.env.ELIZA_STATE_DIR;
    priorLocalMode = process.env.ELIZA_REMOTE_LOCAL_MODE;
    process.env.ELIZA_STATE_DIR = mkdtempSync(
      path.join(tmpdir(), "remote-desktop-test-"),
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

  it("start without confirmed returns CONFIRMATION_REQUIRED", async () => {
    const runtime = createMinimalRuntimeStub();
    const result = await remoteDesktopAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "start a remote session"),
      undefined,
      { parameters: { subaction: "start", confirmed: false } },
      undefined,
      [],
    );
    expect(result?.success).toBe(false);
    const values = result?.values as { error?: string; requiresConfirmation?: boolean };
    expect(values.error).toBe("CONFIRMATION_REQUIRED");
    expect(values.requiresConfirmation).toBe(true);
  });

  it("start with confirmed:true in local mode authorizes a session", async () => {
    const runtime = createMinimalRuntimeStub();
    const result = await remoteDesktopAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "start"),
      undefined,
      { parameters: { subaction: "start", confirmed: true } },
      undefined,
      [],
    );
    // In local mode without a data plane, ingressUrl is null and the action
    // surfaces DATA_PLANE_NOT_CONFIGURED — that's the real, expected failure
    // shape and the action result must carry the sessionId so the user can
    // diagnose / retry.
    const values = result?.values as {
      success?: boolean;
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
    const runtime = createMinimalRuntimeStub();
    const service = getRemoteSessionService();

    // Seed an active session via the service directly so the test doesn't
    // depend on the action's confirmed-true gate.
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
    const runtime = createMinimalRuntimeStub();
    const service = getRemoteSessionService();

    const seeded = await service.startSession({
      requesterIdentity: "test-requester",
      confirmed: true,
    });

    const revoke = await remoteDesktopAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "revoke"),
      undefined,
      {
        parameters: { subaction: "revoke", sessionId: seeded.sessionId },
      },
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
    const runtime = createMinimalRuntimeStub();
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
});
