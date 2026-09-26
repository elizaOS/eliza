import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createStdioBridge } from "../../../../plugins/plugin-native-inference/src/shared/stdio-bridge";
import {
  createAndroidAgentExecutor,
  createMobileBrowserExecutor,
} from "../mobile-remote-target";

function runtime(executeNativeDeviceCommand: (...args: unknown[]) => unknown) {
  return {
    getService: () => ({ executeNativeDeviceCommand }),
  } as unknown as IAgentRuntime;
}

describe("Android background browser receiver", () => {
  it("retains allowlisted agent status over the authenticated Android abstract socket", async () => {
    const socketName = `eliza-remote-test-${randomUUID()}`;
    const received: string[] = [];
    const token = "test-token-strong-enough-for-native-api";
    const server = createServer((socket) => {
      const bridge = createStdioBridge({
        request: async (frame) => {
          expect(frame.method).toBe("http_request");
          const request = frame.payload as {
            method: string;
            path: string;
            headers: Record<string, string>;
          };
          received.push(
            `${request.method} ${request.path} ${request.headers.authorization}`,
          );
          const body = JSON.stringify({ status: "ready" });
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body,
            bodyBase64: Buffer.from(body).toString("base64"),
            bodyEncoding: "base64",
          };
        },
        writeFrame: (frame) => socket.write(JSON.stringify(frame) + "\n"),
      });
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString();
        const index = buffered.indexOf("\n");
        if (index >= 0) {
          void bridge.handleLine(buffered.slice(0, index));
          buffered = buffered.slice(index + 1);
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(`\0${socketName}`, resolve),
    );
    try {
      const executor = createMobileBrowserExecutor(
        runtime(vi.fn()),
        createAndroidAgentExecutor({ apiToken: token, socketName }),
      );
      const result = await executor.execute({
        action: "agent.status",
        payload: {},
        executionId: "status-one",
      });
      expect(result.status).toBe("completed");
      expect(received).toEqual([`GET /api/health Bearer ${token}`]);
      const denied = await executor.execute({
        action: "agent.request",
        payload: { method: "GET", path: "/api/config" },
        executionId: "denied-one",
      });
      expect(denied.status).toBe("rejected");
      expect(received).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("binds exact profile and tab, retaining complete receipts", async () => {
    const receipt = {
      value: {
        profileId: "profile-one",
        result: {
          id: "42",
          frames: [{ text: "complete 私密\n".repeat(1000) }],
        },
      },
    };
    const dispatch = vi.fn().mockResolvedValue(receipt);
    const result = await createMobileBrowserExecutor(runtime(dispatch)).execute(
      {
        action: "browser.command",
        payload: {
          profileId: "profile-one",
          command: { subaction: "snapshot", id: "42" },
        },
        executionId: "execution-one",
      },
    );
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      { subaction: "snapshot", id: "42" },
      "profile-one",
    );
    expect(result).toEqual({
      status: "completed",
      result: {
        status: 200,
        body: JSON.stringify(receipt),
        headers: { "content-type": "application/json" },
      },
    });
  });

  it("rejects unsupported actions and malformed payloads before invoking a device", async () => {
    const dispatch = vi.fn();
    const executor = createMobileBrowserExecutor(runtime(dispatch));
    expect(
      await executor.execute({
        action: "agent.request",
        payload: {},
        executionId: "one",
      }),
    ).toEqual({
      status: "rejected",
      errorCode: "REMOTE_CAPABILITY_UNSUPPORTED",
    });
    await expect(
      executor.execute({
        action: "browser.command",
        payload: { profileId: "profile", command: { subaction: "snapshot" } },
        executionId: "two",
      }),
    ).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("preserves an uncertain dispatched effect without replay", async () => {
    const failure = new Error("Connection ended after effect dispatch");
    const dispatch = vi.fn().mockRejectedValue(failure);
    const executor = createMobileBrowserExecutor(runtime(dispatch));
    await expect(
      executor.execute({
        action: "browser.command",
        payload: {
          profileId: "profile",
          command: { subaction: "click", id: "42", selector: "snapshot:0:1" },
        },
        executionId: "one",
      }),
    ).rejects.toBe(failure);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("explicitly rejects responses above the signed transport limit without truncating", async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValue({ text: "A".repeat(400 * 1024) });
    const result = await createMobileBrowserExecutor(runtime(dispatch)).execute(
      {
        action: "browser.command",
        payload: {
          profileId: "profile",
          command: { subaction: "snapshot", id: "42" },
        },
        executionId: "one",
      },
    );
    expect(result).toEqual({
      status: "rejected",
      errorCode: "REMOTE_LOCAL_RESPONSE_TOO_LARGE",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
