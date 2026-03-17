import { describe, expect, test } from "vitest";
import { PythonPluginBridge } from "../python-bridge";
import type { IPCResponse } from "../types";

type BridgeInternals = {
  initialized: boolean;
  process: {
    stdin?: { write: (json: string) => void };
    kill?: (signal: NodeJS.Signals) => void;
  } | null;
  pendingRequests: Map<
    string,
    {
      resolve: (value: IPCResponse) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >;
  handleData: (data: string) => void;
};

const getBridgeInternals = (
  bridge: PythonPluginBridge,
): PythonPluginBridge & BridgeInternals => {
  return bridge as PythonPluginBridge & BridgeInternals;
};

describe("Python Bridge - limits", () => {
  test("sendRequest should reject when maxPendingRequests is exceeded", async () => {
    const bridge = new PythonPluginBridge({
      moduleName: "x",
      maxPendingRequests: 1,
    });

    // Simulate started bridge without spawning a process.
    const bridgeInternals = getBridgeInternals(bridge);
    bridgeInternals.initialized = true;
    bridgeInternals.process = {
      stdin: { write: (_json: string) => {} },
    };

    bridgeInternals.pendingRequests.set("req_0", {
      resolve: (_value: IPCResponse) => {},
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
    const bridgeInternals = getBridgeInternals(bridge);
    bridgeInternals.process = {
      kill: (_sig: string) => {
        killed = true;
      },
    };

    bridgeInternals.handleData("0123456789ABCDEF"); // > 10 bytes

    expect(killed).toBe(true);
  });
});
