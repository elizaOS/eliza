import { describe, expect, it } from "vitest";
import { BrowserService } from "./browser-service.js";

function serviceWithNativeFailure(error: Error): BrowserService {
  const service = new BrowserService({} as never);
  service.setNativeClientTransport({
    readPage: async () => ({}),
    navigate: async () => {},
    executeCommand: async () => {
      throw error;
    },
  });
  return service;
}

describe("BrowserService native dispatch failures", () => {
  it("marks a script-bearing wait as uncertain after native dispatch", async () => {
    const error = new Error("native wait failed");
    const service = serviceWithNativeFailure(error);

    await expect(
      service.execute(
        {
          subaction: "wait",
          script: 'document.body.dataset.probe = "1"',
        },
        undefined,
        "native-client",
      ),
    ).rejects.toMatchObject({
      kind: "UNCERTAIN_OUTCOME",
      cause: error,
    });
  });

  it("keeps a pure wait failure as the original native error", async () => {
    const error = new Error("native delay failed");
    const service = serviceWithNativeFailure(error);

    await expect(
      service.execute(
        { subaction: "wait", timeoutMs: 100 },
        undefined,
        "native-client",
      ),
    ).rejects.toBe(error);
  });
});
