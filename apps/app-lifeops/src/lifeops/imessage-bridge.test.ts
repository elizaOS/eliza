import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  clearIMessageBackendCache,
  detectIMessageBackend,
} from "./imessage-bridge.js";

describe("detectIMessageBackend", () => {
  beforeEach(() => {
    clearIMessageBackendCache();
    execFileMock.mockReset();
  });

  it("re-probes after a cached no-backend result so a fresh install is detected", async () => {
    execFileMock
      .mockImplementationOnce(
        (
          _binary: string,
          _args: string[],
          _options: { timeout: number },
          callback: (
            error: Error | null,
            stdout?: string,
            stderr?: string,
          ) => void,
        ) => {
          callback(new Error("imsg not installed"));
        },
      )
      .mockImplementationOnce(
        (
          _binary: string,
          _args: string[],
          _options: { timeout: number },
          callback: (
            error: Error | null,
            stdout?: string,
            stderr?: string,
          ) => void,
        ) => {
          callback(null, "imsg 1.0.0\n", "");
        },
      );

    await expect(detectIMessageBackend()).resolves.toBe("none");
    await expect(detectIMessageBackend()).resolves.toBe("imsg");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
