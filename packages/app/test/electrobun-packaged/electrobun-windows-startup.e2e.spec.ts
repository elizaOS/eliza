import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { type MockApiServer, startMockApiServer } from "./mock-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";
import { hasPackagedRendererBootstrapRequests } from "./windows-bootstrap";

test("packaged Windows app bootstraps the renderer against the external API override", async () => {
  test.skip(
    process.platform !== "win32",
    "Windows startup test is win32-only.",
  );

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-win-e2e-"));
  const extractDir = path.join(tempRoot, "extract");
  const launcherPath = await resolvePackagedLauncher(extractDir);
  test.skip(!launcherPath, "Windows packaged launcher is required");

  let api: MockApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;

  try {
    api = await startMockApiServer({ onboardingComplete: true, port: 0 });
    harness = new PackagedDesktopHarness({
      tempRoot,
      launcherPath,
      apiBase: api.baseUrl,
    });

    await harness.start();

    await expect
      .poll(() => hasPackagedRendererBootstrapRequests(api?.requests ?? []), {
        timeout: process.env.CI ? 180_000 : 90_000,
        message:
          "Expected the packaged Windows renderer to reach the external API bootstrap requests",
      })
      .toBe(true);

    expect(api.requests.length).toBeGreaterThan(0);
    expect(
      `${harness.logs?.stdout.join("") ?? ""}\n${harness.logs?.stderr.join("") ?? ""}`,
    ).not.toMatch(
      /Fatal error during startup|startup failure|Cannot find module/i,
    );
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
    await fs
      .rm(tempRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
});
