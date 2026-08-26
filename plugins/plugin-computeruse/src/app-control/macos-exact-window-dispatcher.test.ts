/** Verifies the experimental helper resolver requires direct macOS, explicit opt-in, and an executable exact-name file. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MacosExperimentalExactWindowDispatcher,
  parseExperimentalExactWindowDispatchResult,
  resolveExperimentalExactWindowHelper,
} from "./macos-exact-window-dispatcher.js";

const temporaryRoots: string[] = [];

function helperFixture(mode = 0o755): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exact-window-helper-"));
  temporaryRoots.push(root);
  const helper = path.join(root, "computeruse-exact-window-helper");
  fs.writeFileSync(helper, "fixture");
  fs.chmodSync(helper, mode);
  return helper;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("experimental exact-window helper resolution", () => {
  it("accepts only an explicitly enabled direct macOS executable", () => {
    const helper = helperFixture();
    expect(
      resolveExperimentalExactWindowHelper(
        {
          ELIZA_BUILD_VARIANT: "direct",
          ELIZA_COMPUTERUSE_EXPERIMENTAL_EXACT_WINDOW: "1",
          ELIZA_COMPUTERUSE_EXACT_WINDOW_HELPER_PATH: helper,
        },
        "darwin",
      ),
    ).toBe(helper);
  });

  it("resolves the fixed sibling of an embedded direct runtime", () => {
    const helper = helperFixture();
    const runtime = path.join(path.dirname(helper), "eliza-dist");
    fs.mkdirSync(runtime);
    expect(
      resolveExperimentalExactWindowHelper(
        {
          ELIZA_BUILD_VARIANT: "direct",
          ELIZA_DESKTOP_PACKAGED_RUNTIME: "1",
          ELIZA_COMPUTERUSE_EXPERIMENTAL_EXACT_WINDOW: "1",
          ELIZA_COMPUTERUSE_EXACT_WINDOW_HELPER_PATH: "/untrusted/override",
        },
        "darwin",
        runtime,
      ),
    ).toBe(helper);
  });

  it("refuses Store even when a helper path and runtime opt-in are supplied", () => {
    expect(
      resolveExperimentalExactWindowHelper(
        {
          ELIZA_BUILD_VARIANT: "store",
          ELIZA_COMPUTERUSE_EXPERIMENTAL_EXACT_WINDOW: "1",
          ELIZA_COMPUTERUSE_EXACT_WINDOW_HELPER_PATH: helperFixture(),
        },
        "darwin",
      ),
    ).toBeNull();
  });

  it("refuses missing opt-in, non-executable files, and wrong platforms", () => {
    const helper = helperFixture(0o600);
    expect(
      resolveExperimentalExactWindowHelper(
        { ELIZA_COMPUTERUSE_EXACT_WINDOW_HELPER_PATH: helper },
        "darwin",
      ),
    ).toBeNull();
    expect(
      resolveExperimentalExactWindowHelper(
        {
          ELIZA_COMPUTERUSE_EXPERIMENTAL_EXACT_WINDOW: "1",
          ELIZA_COMPUTERUSE_EXACT_WINDOW_HELPER_PATH: helper,
        },
        "darwin",
      ),
    ).toBeNull();
    expect(
      resolveExperimentalExactWindowHelper(
        {
          ELIZA_COMPUTERUSE_EXPERIMENTAL_EXACT_WINDOW: "1",
          ELIZA_COMPUTERUSE_EXACT_WINDOW_HELPER_PATH: helperFixture(),
        },
        "linux",
      ),
    ).toBeNull();
  });
});

describe("experimental exact-window helper adapter", () => {
  it.skipIf(process.platform !== "darwin")(
    "accepts the dispatch receipt emitted by the actual helper process",
    () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "exact-window-wire-contract-"),
      );
      temporaryRoots.push(root);
      const sourceDir = fileURLToPath(
        new URL(
          "../../../../packages/app-core/platforms/electrobun/direct-only/computeruse-exact-window/",
          import.meta.url,
        ),
      );
      const helper = path.join(root, "computeruse-exact-window-helper");
      execFileSync("xcrun", [
        "swiftc",
        "-framework",
        "ApplicationServices",
        "-framework",
        "AppKit",
        path.join(sourceDir, "ExperimentalExactWindowProtocol.swift"),
        path.join(sourceDir, "ExperimentalExactWindowSPI.swift"),
        path.join(sourceDir, "main.swift"),
        "-o",
        helper,
      ]);
      const stdout = execFileSync(helper, [], {
        encoding: "utf8",
        input: JSON.stringify({
          command: "wire-contract",
          observationId: "observation-wire",
          pid: 42,
          windowId: 99,
          expectedWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
          screenPoint: { x: 10, y: 20 },
        }),
      });
      const envelope = JSON.parse(stdout) as {
        ok: boolean;
        result?: unknown;
      };
      expect(envelope.ok).toBe(true);
      expect(
        parseExperimentalExactWindowDispatchResult(envelope.result),
      ).toEqual({
        success: true,
        route: "experimental_direct_exact_window",
        observationId: "observation-wire",
        targetPid: 42,
        targetWindowId: 99,
        targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
        pointerBefore: { x: 10, y: 20 },
        pointerAfter: { x: 10, y: 20 },
      });
    },
  );

  it("probes before dispatch and binds the exact observation, PID, window, and bounds", async () => {
    const requests: Record<string, unknown>[] = [];
    const dispatcher = new MacosExperimentalExactWindowDispatcher({
      resolveHelper: () => "/fixture/computeruse-exact-window-helper",
      invokeHelper: async (_helper, request) => {
        requests.push(request);
        if (request.command === "probe") {
          return {
            route: "experimental_direct_exact_window",
            available: true,
            minimumMacOSMet: true,
            missingSymbols: [],
            defaultEnabled: false,
          };
        }
        return {
          success: true,
          route: "experimental_direct_exact_window",
          observationId: "observation-7",
          targetPid: 42,
          targetWindowId: 99,
          targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
          pointerBefore: { x: 10, y: 20 },
          pointerAfter: { x: 10, y: 20 },
        };
      },
    });

    const result = await dispatcher.dispatch({
      app: { id: "fixture", name: "Fixture", pid: 42, active: false },
      state: {
        stateId: "observation-7",
        app: { id: "fixture", name: "Fixture", pid: 42, active: false },
        capturedAt: "2026-08-23T00:00:00.000Z",
        permission: "ready",
        screenshotBounds: { x: 100, y: 200, width: 800, height: 600 },
        elements: [],
        axText: "",
      },
      element: {
        locator: [0, 2],
        role: "AXButton",
        label: "Fixture action",
        bounds: { x: 300, y: 400, width: 80, height: 40 },
        actions: [],
        enabled: true,
        focused: false,
        secure: false,
      },
      request: {
        app: "fixture",
        stateId: "observation-7",
        kind: "click",
        element_index: 3,
        allowExperimentalExactWindow: true,
      },
      expectedWindowId: 99,
    });

    expect(requests).toEqual([
      { command: "probe" },
      {
        command: "dispatch",
        experimental: true,
        route: "experimental_direct_exact_window",
        observationId: "observation-7",
        action: "click",
        pid: 42,
        windowId: 99,
        screenPoint: { x: 340, y: 420 },
        windowPoint: { x: 240, y: 220 },
        expectedWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
        expectedElement: {
          locator: [0, 2],
          role: "AXButton",
          subrole: null,
          label: "Fixture action",
          value: null,
          description: null,
          bounds: { x: 300, y: 400, width: 80, height: 40 },
          actions: [],
          enabled: true,
          focused: false,
          selected: null,
          secure: false,
        },
        direction: undefined,
        amount: undefined,
      },
    ]);
    expect(result.pointerAfter).toEqual(result.pointerBefore);
  });

  it("refuses without sending dispatch when the capability probe is incomplete", async () => {
    const commands: unknown[] = [];
    const dispatcher = new MacosExperimentalExactWindowDispatcher({
      resolveHelper: () => "/fixture/computeruse-exact-window-helper",
      invokeHelper: async (_helper, request) => {
        commands.push(request.command);
        return {
          route: "experimental_direct_exact_window",
          available: false,
          minimumMacOSMet: true,
          missingSymbols: ["SLEventPostToPid"],
          defaultEnabled: false,
        };
      },
    });

    await expect(
      dispatcher.dispatch({
        app: { id: "fixture", name: "Fixture", pid: 42, active: false },
        state: {
          stateId: "observation-7",
          app: { id: "fixture", name: "Fixture", pid: 42, active: false },
          capturedAt: "2026-08-23T00:00:00.000Z",
          permission: "ready",
          screenshotBounds: { x: 0, y: 0, width: 800, height: 600 },
          elements: [],
          axText: "",
        },
        element: {
          locator: [0],
          role: "AXButton",
          bounds: { x: 10, y: 10, width: 20, height: 20 },
          actions: [],
          enabled: true,
          focused: false,
          secure: false,
        },
        request: {
          app: "fixture",
          stateId: "observation-7",
          kind: "click",
          element_index: 1,
        },
        expectedWindowId: 99,
      }),
    ).rejects.toThrow("failed its runtime capability probe");
    expect(commands).toEqual(["probe"]);
  });

  it("rejects a malformed dispatch receipt at the native-process boundary", async () => {
    const dispatcher = new MacosExperimentalExactWindowDispatcher({
      resolveHelper: () => "/fixture/computeruse-exact-window-helper",
      invokeHelper: async (_helper, request) =>
        request.command === "probe"
          ? {
              route: "experimental_direct_exact_window",
              available: true,
              minimumMacOSMet: true,
              missingSymbols: [],
              defaultEnabled: false,
            }
          : {
              success: true,
              route: "experimental_direct_exact_window",
              observationId: "observation-7",
              targetPid: 42,
              targetWindowId: 99,
            },
    });
    await expect(
      dispatcher.dispatch({
        app: { id: "fixture", name: "Fixture", pid: 42, active: false },
        state: {
          stateId: "observation-7",
          app: { id: "fixture", name: "Fixture", pid: 42, active: false },
          capturedAt: "2026-08-23T00:00:00.000Z",
          permission: "ready",
          screenshotBounds: { x: 0, y: 0, width: 800, height: 600 },
          elements: [],
          axText: "",
        },
        element: {
          locator: [0],
          role: "AXButton",
          bounds: { x: 10, y: 10, width: 20, height: 20 },
          actions: [],
          enabled: true,
          focused: false,
          secure: false,
        },
        request: {
          app: "fixture",
          stateId: "observation-7",
          kind: "click",
          element_index: 1,
        },
        expectedWindowId: 99,
      }),
    ).rejects.toThrow("invalid dispatch receipt");
  });
});
