/**
 * Private cloud registration state machine (#18056 review repairs).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePrivateCloudSurfaces,
  getPrivateCloudRegistrationSnapshot,
  pathNeedsPrivateCloudSurfaces,
  resetPrivateCloudRegistrationForTests,
  retryPrivateCloudSurfaces,
  setPrivateCloudLoadForTests,
} from "./private-cloud-registration";

const appMainSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../app/src/main.tsx"),
  "utf8",
);

afterEach(() => {
  resetPrivateCloudRegistrationForTests();
});

describe("pathNeedsPrivateCloudSurfaces", () => {
  it("is false for public auth and marketing paths", () => {
    for (const path of [
      "/login",
      "/join",
      "/get-started",
      "/auth/success",
      "/payment/abc",
      "/",
      "/chat/foo",
    ]) {
      expect(pathNeedsPrivateCloudSurfaces(path), path).toBe(false);
    }
  });

  it("is true only for dashboard console paths", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/",
      "/dashboard/billing",
      "/dashboard/admin",
      "dashboard/agents",
    ]) {
      expect(pathNeedsPrivateCloudSurfaces(path), path).toBe(true);
    }
  });
});

describe("ensurePrivateCloudSurfaces", () => {
  it("starts idle and never auto-loads until ensure is called", () => {
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("idle");
  });

  it("reaches ready after successful ensure", async () => {
    setPrivateCloudLoadForTests(async () => {
      /* no-op success without importing private domains */
    });
    const pending = ensurePrivateCloudSurfaces();
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("pending");
    await pending;
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("ready");
    expect(getPrivateCloudRegistrationSnapshot().error).toBeNull();
  });

  it("records error status, avoids unhandled rejection, and retries", async () => {
    let attempts = 0;
    setPrivateCloudLoadForTests(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("import batch failed");
      }
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      // Fire-and-forget must not become an unhandled rejection.
      void ensurePrivateCloudSurfaces();
      await Promise.resolve();
      await Promise.resolve();
      expect(getPrivateCloudRegistrationSnapshot().status).toBe("error");
      expect(getPrivateCloudRegistrationSnapshot().error?.message).toBe(
        "import batch failed",
      );
      expect(unhandled).toEqual([]);

      await retryPrivateCloudSurfaces();
      expect(getPrivateCloudRegistrationSnapshot().status).toBe("ready");
      expect(attempts).toBe(2);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("web shell public boot contract", () => {
  it("does not invoke private registration from packages/app main shell factory", () => {
    expect(appMainSource).toContain("registerPublicCloudSurfaces()");
    const factory = appMainSource.slice(
      appMainSource.indexOf("const CloudRouterShell = lazy"),
      appMainSource.indexOf("const ChatWidgetHarness"),
    );
    expect(factory).toContain("registerPublicCloudSurfaces()");
    expect(factory).not.toContain("registerPrivateCloudSurfaces");
    expect(factory).not.toContain("ensurePrivateCloudSurfaces");
    expect(factory).not.toMatch(/void\s+registerPrivateCloudSurfaces\s*\(/);
  });
});
