/** Exercises the real renderer stream/cancellation adapter with a controlled native boundary; no device or alarm effect. */
import { type ClockProposal, getClockHost } from "@elizaos/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const status = {
    supported: true,
    agentBase: "https://agent.example/api/v1/eliza/agents/a",
    capabilities: ["clock.handoff.v1", "clock.handoff.v2"],
    scope: "a".repeat(64),
    installationId: "fixture",
    reason: null,
    context: { sensitive: false, revision: 1, timeZone: "UTC" },
  };
  return {
    status,
    callbacks: new Map<
      string,
      (value: {
        requestId: string;
        data?: string;
        done?: boolean;
        error?: string;
      }) => void
    >(),
    remove: vi.fn(async () => {}),
    cancel: vi.fn(async () => ({ cancelled: true })),
    request: vi.fn(),
    getStatus: vi.fn(async (): Promise<unknown> => status),
    list: vi.fn(
      async (): Promise<unknown> => ({ scope: status.scope, proposals: [] }),
    ),
    review: vi.fn(
      async (): Promise<unknown> => ({
        result: { kind: "clock-handoff", action: "set", status: "opened" },
        receiptPending: false,
      }),
    ),
    cancelClock: vi.fn(async () => ({ cancelled: true })),
  };
});
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    isPluginAvailable: () => true,
  },
  registerPlugin: () => ({
    getStatus: fixture.getStatus,
    listProposals: fixture.list,
    reviewClock: fixture.review,
    cancelClock: fixture.cancelClock,
    requestAgent: fixture.request,
    cancelAgentRequest: fixture.cancel,
    addListener: async (
      event: string,
      callback: (value: {
        requestId: string;
        data?: string;
        done?: boolean;
        error?: string;
      }) => void,
    ) => {
      fixture.callbacks.set(event, callback);
      return { remove: fixture.remove };
    },
  }),
}));

import {
  clockAgentRelativePath,
  nativeClockTransportForUrl,
} from "./clock-native-host";

function proposal(): ClockProposal {
  return {
    id: "proposal",
    digest: "b".repeat(64),
    state: "pending",
    expiresAt: "2026-10-07T09:00:00.000Z",
    operation: {
      type: "clock_handoff",
      action: "set",
      hour: 9,
      minute: 0,
      label: "Clock fixture",
      timeZone: "UTC",
    },
  };
}

function host() {
  const value = getClockHost();
  if (!value) throw new Error("Missing registered native Clock host");
  return value;
}

describe("native Clock renderer boundary", () => {
  beforeEach(() => {
    fixture.getStatus.mockReset();
    fixture.getStatus.mockResolvedValue(fixture.status);
    fixture.list.mockReset();
    fixture.list.mockResolvedValue({
      scope: fixture.status.scope,
      proposals: [],
    });
    fixture.review.mockClear();
    fixture.cancelClock.mockClear();
    fixture.request.mockClear();
  });
  it("handles a native proposal change outside ClockView through the global active-control lifecycle", async () => {
    const alarmId = "387f40dd-93a9-4bdd-95ee-da48c3a1b188";
    fixture.getStatus.mockResolvedValue({
      ...fixture.status,
      capabilities: ["clock.alarms.v1"],
      context: {
        sensitive: false,
        revision: 1,
        timeZone: "UTC",
        alarmsStatus: "available",
        alarmsObservedAt: Date.now(),
        alarmsRevision: 1,
        alarms: [],
      },
    });
    const active = {
      ...proposal(),
      id: "global-snooze",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      operation: { type: "clock_alarm", action: "snooze", alarmId, minutes: 5 },
    };
    fixture.list.mockResolvedValue({
      scope: fixture.status.scope,
      proposals: [active],
    });
    fixture.review.mockResolvedValueOnce({
      result: {
        kind: "clock-alarm",
        action: "snooze",
        status: "snoozed",
        alarmId,
        nextAt: Date.now() + 300_000,
      },
      receiptPending: false,
    });
    const changed = fixture.callbacks.get("proposalsChanged");
    if (!changed) throw new Error("Missing app-global Clock listener");
    changed({ requestId: "" });
    await vi.waitFor(() => expect(fixture.review).toHaveBeenCalledOnce());
    expect(fixture.review).toHaveBeenCalledWith({
      scope: fixture.status.scope,
      proposalId: active.id,
      operationId: active.id,
      operation: active.operation,
    });
    changed({ requestId: "" });
    await vi.waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(2));
    expect(fixture.review).toHaveBeenCalledOnce();
  });
  it("rejects malformed host status and leaves transport selection on its existing path", async () => {
    const { context: _context, ...missingContext } = fixture.status;
    for (const raw of [
      null,
      missingContext,
      { ...fixture.status, approved: true },
      { ...fixture.status, supported: "true" },
      { ...fixture.status, capabilities: [] },
      {
        ...fixture.status,
        capabilities: ["clock.handoff.v1", "clock.handoff.v1"],
      },
      { ...fixture.status, capabilities: ["other.v1"] },
      { ...fixture.status, capabilities: Array(1) },
      { ...fixture.status, scope: "owner" },
      { ...fixture.status, installationId: "../other" },
      { ...fixture.status, agentBase: null },
      { ...fixture.status, agentBase: "https://user:secret@agent.example" },
      { ...fixture.status, agentBase: "http://public.example" },
      { ...fixture.status, agentBase: "https://agent.example/a/../b" },
      {
        ...fixture.status,
        context: { sensitive: true, revision: 1, timeZone: "UTC" },
      },
      {
        ...fixture.status,
        context: { sensitive: false, revision: -1, timeZone: "UTC" },
      },
      {
        ...fixture.status,
        context: { sensitive: false, revision: 1.5, timeZone: "UTC" },
      },
      {
        ...fixture.status,
        context: { sensitive: false, revision: 1, timeZone: "Not/AZone" },
      },
      {
        ...fixture.status,
        context: {
          sensitive: false,
          revision: 1,
          timeZone: "UTC",
          owner: "other",
        },
      },
    ]) {
      fixture.getStatus.mockResolvedValueOnce(raw);
      await expect(host().status()).rejects.toThrow();
      fixture.getStatus.mockResolvedValueOnce(raw);
      await expect(
        nativeClockTransportForUrl(
          "https://agent.example/api/v1/eliza/agents/a/api/chat",
          { method: "POST", body: "{}" },
        ),
      ).resolves.toBeNull();
    }
    expect(fixture.request).not.toHaveBeenCalled();
    expect(await host().status()).toEqual(fixture.status);
  });
  it("rejects malformed proposal metadata and operations through the registered host", async () => {
    await host().status();
    const valid = proposal();
    for (const raw of [
      null,
      { ...valid, extra: true },
      { ...valid, id: "../other" },
      { ...valid, digest: "approved" },
      { ...valid, state: "created" },
      { ...valid, expiresAt: "tomorrow" },
      { ...valid, expiresAt: "2026-02-30T09:00:00.000Z" },
      { ...valid, operation: { ...valid.operation, days: [2, 2] } },
      { ...valid, operation: { ...valid.operation, days: ["2"] } },
    ]) {
      fixture.list.mockResolvedValueOnce({
        scope: fixture.status.scope,
        proposals: [raw],
      });
      await expect(host().proposals()).rejects.toThrow();
    }
    fixture.list.mockResolvedValueOnce({
      scope: fixture.status.scope,
      proposals: [valid, valid],
    });
    await expect(host().proposals()).rejects.toThrow("Duplicate");
    fixture.list.mockResolvedValueOnce({
      scope: fixture.status.scope,
      proposals: [valid],
      approval: true,
    });
    await expect(host().proposals()).rejects.toThrow();
    fixture.list.mockResolvedValueOnce({
      scope: fixture.status.scope,
      proposals: [valid],
    });
    expect((await host().proposals()).proposals).toEqual([valid]);
  });
  it("does not retire an active review or change its scope for a malformed proposal batch", async () => {
    await host().status();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.review.mockImplementationOnce(async () => {
      await gate;
      return {
        result: { kind: "clock-handoff", action: "set", status: "opened" },
        receiptPending: false,
      };
    });
    const reviewing = host().review(
      proposal(),
      fixture.status.scope,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(fixture.review).toHaveBeenCalledTimes(1));
    fixture.list.mockResolvedValueOnce({
      scope: "c".repeat(64),
      proposals: [{ ...proposal(), id: "bad/id" }],
    });
    await expect(host().proposals()).rejects.toThrow();
    expect(fixture.cancelClock).not.toHaveBeenCalled();
    release();
    expect((await reviewing).handoff.status).toBe("opened");
    expect(fixture.cancelClock).toHaveBeenCalledTimes(1);
  });
  it("retains unsupported v2 rows but rejects recurrence before invoking a v1 bridge", async () => {
    fixture.getStatus.mockResolvedValue({
      ...fixture.status,
      capabilities: ["clock.handoff.v1"],
    });
    const repeated: ClockProposal = {
      ...proposal(),
      operation: {
        ...proposal().operation,
        action: "set",
        hour: 9,
        minute: 0,
        label: "Clock fixture",
        timeZone: "UTC",
        days: [2, 3, 4, 5, 6],
      },
    };
    fixture.list.mockResolvedValueOnce({
      scope: fixture.status.scope,
      proposals: [repeated],
    });
    await host().status();
    expect((await host().proposals()).proposals).toEqual([repeated]);
    await expect(
      host().review(
        repeated,
        fixture.status.scope,
        new AbortController().signal,
      ),
    ).rejects.toThrow("capability");
    const explicitOnce: ClockProposal = {
      ...repeated,
      operation: {
        ...repeated.operation,
        action: "set",
        hour: 9,
        minute: 0,
        label: "Clock fixture",
        timeZone: "UTC",
        days: [],
      },
    };
    await expect(
      host().review(
        explicitOnce,
        fixture.status.scope,
        new AbortController().signal,
      ),
    ).rejects.toThrow("capability");
    expect(fixture.review).not.toHaveBeenCalled();
    expect(fixture.cancelClock).not.toHaveBeenCalled();
    expect(
      (
        await host().review(
          proposal(),
          fixture.status.scope,
          new AbortController().signal,
        )
      ).handoff.status,
    ).toBe("opened");
    expect(fixture.review).toHaveBeenCalledTimes(1);
  });
  it("keeps the selected prefix and rejects sibling profiles/origins", () => {
    const base = "https://agent.example/api/v1/eliza/agents/a";
    expect(
      clockAgentRelativePath(
        `${base}/api/conversations/id/messages/stream`,
        base,
      ),
    ).toBe("/api/conversations/id/messages/stream");
    expect(
      clockAgentRelativePath(
        "https://agent.example/api/v1/eliza/agents/b/api/chat",
        base,
      ),
    ).toBeNull();
    expect(
      clockAgentRelativePath("https://other.example/api/chat", base),
    ).toBeNull();
  });
  it("delivers Unicode SSE before the native request completes and releases listeners", async () => {
    fixture.remove.mockClear();
    fixture.cancel.mockClear();
    fixture.request.mockImplementation(
      async (input: { requestId: string }) => ({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        data: "",
        streamed: true,
        requestId: input.requestId,
      }),
    );
    const url =
      "https://agent.example/api/v1/eliza/agents/a/api/conversations/id/messages/stream";
    const transport = await nativeClockTransportForUrl(url, {
      method: "POST",
      body: "{}",
    });
    expect(transport).not.toBeNull();
    if (!transport) throw new Error("Missing native transport");
    const response = await transport.request(url, {
      method: "POST",
      body: "{}",
      headers: { accept: "text/event-stream" },
    });
    const call = fixture.request.mock.calls.at(-1)?.[0] as {
      requestId: string;
      path: string;
      expectedBase: string;
    };
    expect(call.path).toBe("/api/conversations/id/messages/stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing stream");
    fixture.callbacks.get("agentChunk")?.({
      requestId: call.requestId,
      data: "data: café 🌙\n\n",
    });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "data: café 🌙\n\n",
    );
    fixture.callbacks.get("agentChunk")?.({
      requestId: call.requestId,
      done: true,
    });
    expect((await reader.read()).done).toBe(true);
    await vi.waitFor(() => expect(fixture.remove).toHaveBeenCalledTimes(1));
  });
  it("always removes a listener even when native reader cancellation rejects", async () => {
    fixture.remove.mockClear();
    fixture.cancel.mockRejectedValueOnce(
      new Error("Native cancellation failed"),
    );
    const url =
      "https://agent.example/api/v1/eliza/agents/a/api/conversations/id/messages/stream";
    const transport = await nativeClockTransportForUrl(url, {
      method: "POST",
      body: "{}",
    });
    if (!transport) throw new Error("Missing transport");
    const response = await transport.request(url, {
      method: "POST",
      body: "{}",
      headers: { accept: "text/event-stream" },
    });
    await expect(response.body?.cancel()).rejects.toThrow(
      "Native cancellation failed",
    );
    expect(fixture.remove).toHaveBeenCalledTimes(1);
  });
  it("keeps ordinary transport available for unsupported URLs and absent Clock support", async () => {
    for (const url of ["/api/chat", "http://["]) {
      expect(
        await nativeClockTransportForUrl(url, { method: "POST", body: "{}" }),
      ).toBeNull();
    }
    expect(fixture.getStatus).not.toHaveBeenCalled();
    fixture.getStatus.mockResolvedValueOnce({
      supported: false,
      agentBase: null,
      reason: "Native Clock unavailable",
      capabilities: [],
      scope: null,
      installationId: null,
      context: null,
    });
    expect(
      await nativeClockTransportForUrl(
        "https://agent.example/api/v1/eliza/agents/a/api/chat",
        { method: "POST", body: "{}" },
      ),
    ).toBeNull();
  });
  it.each([204, 205, 304])(
    "preserves a bodyless HTTP %s response and releases a stream listener",
    async (status) => {
      fixture.remove.mockClear();
      fixture.request.mockResolvedValueOnce({
        status,
        headers: {},
        data: "",
        streamed: false,
      });
      const url =
        "https://agent.example/api/v1/eliza/agents/a/api/conversations/id/messages/stream";
      const transport = await nativeClockTransportForUrl(url, {
        method: "POST",
        body: "{}",
      });
      if (!transport) throw new Error("Missing transport");
      const response = await transport.request(url, {
        method: "POST",
        body: "{}",
        headers: { accept: "text/event-stream" },
      });
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(await response.text()).toBe("");
      expect(fixture.remove).toHaveBeenCalledTimes(1);
    },
  );
  it("returns a buffered server error for a streaming request", async () => {
    fixture.remove.mockClear();
    fixture.request.mockResolvedValueOnce({
      status: 403,
      headers: { "content-type": "application/json" },
      data: '{"error":"Owner changed"}',
      streamed: false,
    });
    const url =
      "https://agent.example/api/v1/eliza/agents/a/api/conversations/id/messages/stream";
    const transport = await nativeClockTransportForUrl(url, {
      method: "POST",
      body: "{}",
    });
    if (!transport) throw new Error("Missing transport");
    const response = await transport.request(url, {
      method: "POST",
      body: "{}",
      headers: { accept: "text/event-stream" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Owner changed" });
    expect(fixture.remove).toHaveBeenCalledTimes(1);
  });
});
