import { describe, it, expect, beforeEach } from "vitest";
import { createInMemorySessionStore } from "../src/session.js";

describe("createInMemorySessionStore", () => {
  let store: ReturnType<typeof createInMemorySessionStore>;

  beforeEach(() => {
    store = createInMemorySessionStore();
  });

  it("should create a session with generated sessionId", () => {
    const session = store.createSession({
      sessionKey: "test-key",
      cwd: "/test/path",
    });

    expect(session.sessionId).toBeDefined();
    expect(session.sessionKey).toBe("test-key");
    expect(session.cwd).toBe("/test/path");
    expect(session.createdAt).toBeLessThanOrEqual(Date.now());
    expect(session.abortController).toBeNull();
    expect(session.activeRunId).toBeNull();
  });

  it("should create a session with provided sessionId", () => {
    const session = store.createSession({
      sessionId: "custom-id",
      sessionKey: "test-key",
      cwd: "/test/path",
    });

    expect(session.sessionId).toBe("custom-id");
  });

  it("should retrieve a session by sessionId", () => {
    const created = store.createSession({
      sessionKey: "test-key",
      cwd: "/test/path",
    });

    const retrieved = store.getSession(created.sessionId);
    expect(retrieved).toBe(created);
  });

  it("should return undefined for non-existent session", () => {
    const retrieved = store.getSession("non-existent");
    expect(retrieved).toBeUndefined();
  });

  it("should set and clear active run", () => {
    const session = store.createSession({
      sessionKey: "test-key",
      cwd: "/test/path",
    });

    const abortController = new AbortController();
    store.setActiveRun(session.sessionId, "run-id", abortController);

    expect(session.activeRunId).toBe("run-id");
    expect(session.abortController).toBe(abortController);

    const retrievedByRunId = store.getSessionByRunId("run-id");
    expect(retrievedByRunId).toBe(session);

    store.clearActiveRun(session.sessionId);
    expect(session.activeRunId).toBeNull();
    expect(session.abortController).toBeNull();
  });

  it("should cancel active run", () => {
    const session = store.createSession({
      sessionKey: "test-key",
      cwd: "/test/path",
    });

    const abortController = new AbortController();
    store.setActiveRun(session.sessionId, "run-id", abortController);

    let aborted = false;
    abortController.signal.addEventListener("abort", () => {
      aborted = true;
    });

    const cancelled = store.cancelActiveRun(session.sessionId);
    expect(cancelled).toBe(true);
    expect(aborted).toBe(true);
    expect(session.activeRunId).toBeNull();
    expect(session.abortController).toBeNull();
  });

  it("should return false when cancelling non-existent run", () => {
    const session = store.createSession({
      sessionKey: "test-key",
      cwd: "/test/path",
    });

    const cancelled = store.cancelActiveRun(session.sessionId);
    expect(cancelled).toBe(false);
  });
});
