import { describe, expect, test } from "vitest";
import { PythonPluginBridge } from "../python-bridge";

describe("Python Bridge - limits", () => {
  test("sendRequest should reject when maxPendingRequests is exceeded", async () => {
    const bridge = new PythonPluginBridge({
      moduleName: "x",
      maxPendingRequests: 1,
    });

    // Simulate started bridge without spawning a process.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error test-only access to internals
    bridge.initialized = true;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error test-only access to internals
    bridge.process = {
      stdin: { write: (_json: string) => {} },
    };

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error test-only access to internals
    bridge.pendingRequests.set("req_0", {
      resolve: (_value: object) => {},
      reject: (_err: Error) => {},
      timeout: setTimeout(() => {}, 10_000),
    });

    await expect(
      bridge.sendRequest({
        type: "plugin.init",
        id: "",
        config: {},
      }),
    ).rejects.toThrow(/Too many pending IPC requests/);
  });

  test("handleData should fail closed when stdout buffer exceeds limit", async () => {
    const bridge = new PythonPluginBridge({
      moduleName: "x",
      maxBufferBytes: 10,
    });

    let killed = false;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error test-only access to internals
    bridge.process = {
      kill: (_sig: string) => {
        killed = true;
      },
    };

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error test-only access to internals
    bridge.handleData("0123456789ABCDEF"); // > 10 bytes

    expect(killed).toBe(true);
  });
});
