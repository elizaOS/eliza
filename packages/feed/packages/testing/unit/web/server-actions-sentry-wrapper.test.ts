/**
 * Verifies server-action telemetry and sanitization through an injected
 * observer, independent of Bun's global module-mock registry.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { wrapServerActionWithSentry } from "../../../../apps/web/src/lib/sentry/server-actions";

const startSpanMock = mock((_spanConfig: Record<string, unknown>) => {});
const setTagMock = mock((_key: string, _value: string) => {});
const setContextMock = mock(
  (_key: string, _value: Record<string, unknown>) => {},
);

const telemetry = {
  async startSpan<R>(
    spanConfig: Record<string, unknown>,
    callback: () => Promise<R>,
  ): Promise<R> {
    startSpanMock(spanConfig);
    return callback();
  },
  setTag(key: string, value: string) {
    setTagMock(key, value);
  },
  setContext(key: string, value: Record<string, unknown>) {
    setContextMock(key, value);
  },
};

describe("wrapServerActionWithSentry", () => {
  beforeEach(() => {
    startSpanMock.mockClear();
    setTagMock.mockClear();
    setContextMock.mockClear();
  });

  it("returns action result and creates a span on success", async () => {
    const action = mock(async (input: { value: number }) => input.value * 2);
    const wrapped = wrapServerActionWithSentry(
      "doubleValue",
      action,
      telemetry,
    );

    const result = await wrapped({ value: 21 });

    expect(result).toBe(42);
    expect(action).toHaveBeenCalledTimes(1);
    expect(startSpanMock).toHaveBeenCalledTimes(1);

    const firstSpanCall = startSpanMock.mock.calls[0];
    expect(firstSpanCall?.[0]).toMatchObject({
      op: "server.action",
      name: "server-action.doubleValue",
    });
    expect(setTagMock).toHaveBeenCalledTimes(0);
  });

  it("enriches scope with action context, rethrows, and does not double-capture", async () => {
    const actionError = new Error("action failed");
    const action = mock(
      async (_input: { token: string; amount: number }, _note: string) => {
        throw actionError;
      },
    );
    const wrapped = wrapServerActionWithSentry(
      "failingAction",
      action,
      telemetry,
    );

    await expect(
      wrapped({ token: "secret-token", amount: 10 }, "hello"),
    ).rejects.toThrow("action failed");

    expect(startSpanMock).toHaveBeenCalledTimes(1);

    expect(setTagMock).toHaveBeenCalledWith("surface", "server-action");
    expect(setTagMock).toHaveBeenCalledWith("action", "failingAction");
    expect(setTagMock).toHaveBeenCalledWith("runtime", "nodejs");

    const serverActionContextCall = setContextMock.mock.calls.find(
      (call) => call[0] === "serverAction",
    );
    expect(serverActionContextCall).toBeDefined();
    expect(serverActionContextCall?.[1]).toEqual({
      argCount: 2,
      args: [{ token: "[REDACTED]", amount: 10 }, "[string:5]"],
    });
  });
});
