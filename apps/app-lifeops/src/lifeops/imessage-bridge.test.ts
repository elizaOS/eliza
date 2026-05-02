import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not include the BlueBubbles password in the URL when probing", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    try {
      execFileMock.mockImplementation(
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
      );
      await detectIMessageBackend({
        bluebubblesUrl: "http://example.test:1234",
        bluebubblesPassword: "super-secret",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(typeof url === "string" ? url : url?.toString()).not.toContain(
        "super-secret",
      );
      expect(typeof url === "string" ? url : url?.toString()).not.toContain(
        "password=",
      );
      const headers = (init as RequestInit | undefined)?.headers as
        | Record<string, string>
        | undefined;
      expect(headers?.Authorization).toBe("Bearer super-secret");
    } finally {
      fetchSpy.mockRestore();
    }
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
