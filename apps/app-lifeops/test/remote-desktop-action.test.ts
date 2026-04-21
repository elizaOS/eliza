import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { remoteDesktopAction } from "../src/actions/remote-desktop.js";
import {
  endRemoteSession,
  listActiveSessions,
} from "../src/lifeops/remote-desktop.js";

const SAME_ID = "00000000-0000-0000-0000-000000000001";
const ORIGINAL_MOCK_ENV = process.env.MILADY_TEST_REMOTE_DESKTOP_BACKEND;

function makeRuntime() {
  return { agentId: SAME_ID } as unknown as Parameters<
    NonNullable<typeof remoteDesktopAction.handler>
  >[0];
}

function makeMessage(text = "remote") {
  return {
    entityId: SAME_ID,
    roomId: "00000000-0000-0000-0000-000000000002",
    content: { text },
  } as unknown as Parameters<
    NonNullable<typeof remoteDesktopAction.handler>
  >[1];
}

async function cleanupSessions(): Promise<void> {
  const sessions = await listActiveSessions();
  await Promise.all(sessions.map((session) => endRemoteSession(session.id)));
}

beforeEach(async () => {
  process.env.MILADY_TEST_REMOTE_DESKTOP_BACKEND = "1";
  await cleanupSessions();
});

afterEach(async () => {
  await cleanupSessions();
  if (ORIGINAL_MOCK_ENV === undefined) {
    delete process.env.MILADY_TEST_REMOTE_DESKTOP_BACKEND;
  } else {
    process.env.MILADY_TEST_REMOTE_DESKTOP_BACKEND = ORIGINAL_MOCK_ENV;
  }
});

describe("remoteDesktopAction", () => {
  test("start without confirmed=true returns confirmation prompt without opening a session", async () => {
    const result = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "start" } },
    );
    const r = result as {
      success: boolean;
      text: string;
      values?: { backend?: string; requiresConfirmation?: boolean };
    };

    expect(r.success).toBe(false);
    expect(r.values?.requiresConfirmation).toBe(true);
    expect(r.values?.backend).toBe("tailscale-vnc");
    expect(r.text.toLowerCase()).toContain("confirm");
    expect(await listActiveSessions()).toHaveLength(0);
  });

  test("start(confirmed=true) -> status -> list -> end uses the real in-process session store", async () => {
    const startResult = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "start", confirmed: true } },
    );
    const started = startResult as {
      success: boolean;
      values?: {
        accessCode?: string | null;
        accessUrl?: string | null;
        backend?: string;
        expiresAt?: string | null;
        sessionId?: string;
      };
      data?: { session?: { mockMode?: boolean; status?: string } };
      text: string;
    };

    expect(started.success).toBe(true);
    expect(started.values?.backend).toBe("tailscale-vnc");
    expect(started.values?.accessUrl).toMatch(/^vnc:\/\/127\.0\.0\.1:/);
    expect(typeof started.values?.accessCode).toBe("string");
    expect(typeof started.values?.expiresAt).toBe("string");
    expect(started.data?.session?.mockMode).toBe(true);
    expect(started.data?.session?.status).toBe("active");
    expect(started.text).toContain("Remote session active");

    const sessionId = started.values?.sessionId;
    expect(typeof sessionId).toBe("string");
    expect(sessionId?.length).toBeGreaterThan(0);

    const statusResult = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "status", sessionId } },
    );
    const status = statusResult as {
      success: boolean;
      values?: { status?: string };
      data?: { session?: { id?: string; status?: string } };
    };
    expect(status.success).toBe(true);
    expect(status.values?.status).toBe("active");
    expect(status.data?.session?.id).toBe(sessionId);

    const listResult = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "list" } },
    );
    const list = listResult as {
      success: boolean;
      values?: { count?: number };
      data?: { sessions?: Array<{ id: string }> };
    };
    expect(list.success).toBe(true);
    expect(list.values?.count).toBe(1);
    expect(list.data?.sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sessionId })]),
    );

    const endResult = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "end", sessionId } },
    );
    const ended = endResult as {
      success: boolean;
      values?: { sessionId?: string };
    };
    expect(ended.success).toBe(true);
    expect(ended.values?.sessionId).toBe(sessionId);

    const postEnd = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "status", sessionId } },
    );
    const postEndTyped = postEnd as {
      success: boolean;
      values?: { status?: string };
    };
    expect(postEndTyped.success).toBe(true);
    expect(postEndTyped.values?.status).toBe("ended");
    expect(await listActiveSessions()).toHaveLength(0);
  });

  test("status and end require a session id", async () => {
    const statusResult = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "status" } },
    );
    const endResult = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "end" } },
    );

    expect(
      (statusResult as { values?: { error?: string } }).values?.error,
    ).toBe("MISSING_SESSION_ID");
    expect((endResult as { values?: { error?: string } }).values?.error).toBe(
      "MISSING_SESSION_ID",
    );
  });
});
