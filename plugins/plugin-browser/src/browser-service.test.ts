import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { browserAction } from "./actions/browser.js";
import { BROWSER_SERVICE_TYPE, BrowserService } from "./browser-service.js";

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

describe("BrowserService.hasActableTarget", () => {
  it("returns false when no bridge is configured and no profile is connected", async () => {
    delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
    const runtime = {
      getSetting: () => null,
      reportError: () => {},
    } as unknown as IAgentRuntime;
    const service = await BrowserService.start(runtime);
    try {
      expect(service.hasActableTarget()).toBe(false);
    } finally {
      await service.stop();
    }
  });

  it("returns true when desktop workspace bridge is configured via env", async () => {
    process.env.ELIZA_BROWSER_WORKSPACE_URL = "http://127.0.0.1:4444";
    const runtime = {
      getSetting: () => null,
      reportError: () => {},
    } as unknown as IAgentRuntime;
    const service = await BrowserService.start(runtime);
    try {
      expect(service.hasActableTarget()).toBe(true);
    } finally {
      delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
      await service.stop();
    }
  });

  it("returns true when desktop workspace bridge is configured via runtime setting", async () => {
    delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
    const runtime = {
      getSetting: (key: string) =>
        key === "ELIZA_BROWSER_WORKSPACE_URL" ? "http://127.0.0.1:4444" : null,
      reportError: () => {},
    } as unknown as IAgentRuntime;
    const service = await BrowserService.start(runtime);
    try {
      expect(service.hasActableTarget()).toBe(true);
    } finally {
      await service.stop();
    }
  });

  it("returns true when an external target is registered", async () => {
    delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
    const runtime = {
      getSetting: () => null,
      reportError: () => {},
    } as unknown as IAgentRuntime;
    const service = await BrowserService.start(runtime);
    try {
      service.registerTarget({
        id: "mock-custom-target",
        name: "Mock Target",
        description: "Mock Target Description",
        available: async () => true,
        execute: async () => ({ value: {} }),
      });
      expect(service.hasActableTarget()).toBe(true);
    } finally {
      await service.stop();
    }
  });
});

describe("browserAction.validate", () => {
  it("returns false when no browser target can act", async () => {
    delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
    const service = await BrowserService.start({
      getSetting: () => null,
      reportError: () => {},
    } as unknown as IAgentRuntime);
    const runtime = {
      getSetting: () => null,
      getService: (type: string) => (type === BROWSER_SERVICE_TYPE ? service : null),
    } as unknown as IAgentRuntime;
    try {
      const canValidate = await browserAction.validate(runtime, {} as Memory);
      expect(canValidate).toBe(false);
    } finally {
      await service.stop();
    }
  });

  it("returns true when desktop bridge is configured", async () => {
    process.env.ELIZA_BROWSER_WORKSPACE_URL = "http://127.0.0.1:4444";
    const runtime = {
      getSetting: () => null,
      getService: () => null,
    } as unknown as IAgentRuntime;
    try {
      const canValidate = await browserAction.validate(runtime, {} as Memory);
      expect(canValidate).toBe(true);
    } finally {
      delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
    }
  });

  it("returns true when a custom target is registered on the service", async () => {
    delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
    const service = await BrowserService.start({
      getSetting: () => null,
      reportError: () => {},
    } as unknown as IAgentRuntime);
    service.registerTarget({
      id: "computeruse",
      name: "Computer Use Target",
      description: "Controls browser via computer use",
      available: async () => true,
      execute: async () => ({ value: {} }),
    });
    const runtime = {
      getSetting: () => null,
      getService: (type: string) => (type === BROWSER_SERVICE_TYPE ? service : null),
    } as unknown as IAgentRuntime;
    try {
      const canValidate = await browserAction.validate(runtime, {} as Memory);
      expect(canValidate).toBe(true);
    } finally {
      await service.stop();
    }
  });
});
