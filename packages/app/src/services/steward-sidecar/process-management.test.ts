import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForHealthy } from "./health-check";
import {
  allocateFirstFreeLoopbackPort,
  generateApiKey,
  generateMasterPassword,
} from "./helpers";
import { pipeOutput } from "./process-management";

afterEach(() => vi.unstubAllGlobals());

describe("sidecar process boundaries", () => {
  it("preserves split UTF-8 and complete lines and releases the reader", async () => {
    const bytes = new TextEncoder().encode("first 🌍\nsecond\r\nlast");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8, 13));
        controller.enqueue(bytes.slice(13));
        controller.close();
      },
    });
    const lines: string[] = [];
    await pipeOutput(stream, "stdout", (line) => lines.push(line));
    expect(lines).toEqual(["first 🌍", "second", "last"]);
    expect(stream.locked).toBe(false);
  });
  it("cancels an in-flight health request with the caller's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("sidecar stopped");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => reject(options.signal?.reason),
              { once: true },
            );
            controller.abort(reason);
          }),
      ),
    );
    await expect(
      waitForHealthy("http://127.0.0.1:3200", controller),
    ).rejects.toBe(reason);
  });
  it("rejects fractional ports before opening a server", async () => {
    await expect(allocateFirstFreeLoopbackPort(3200.5)).rejects.toThrow(
      "Invalid preferred port",
    );
    await expect(
      allocateFirstFreeLoopbackPort(3200, { maxHops: 0 }),
    ).rejects.toThrow("Invalid port search length");
  });
  it("retains the credential wire format and independent random values", () => {
    expect(generateApiKey()).toMatch(/^stw_[0-9a-f]{64}$/);
    expect(generateMasterPassword()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateMasterPassword()).not.toBe(generateMasterPassword());
  });
});
