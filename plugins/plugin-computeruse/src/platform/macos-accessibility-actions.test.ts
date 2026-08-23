import { describe, expect, it, vi } from "vitest";
import { MacosAccessibilityController } from "./macos-accessibility-actions.js";

function nativeSnapshot(app = "TextEdit", pid = 42): string {
  return JSON.stringify({
    app,
    pid,
    elements: [
      {
        path: [0, 2],
        role: "AXButton",
        subrole: "AXCloseButton",
        label: "Close",
        bbox: [10, 20, 30, 40],
        actions: ["AXPress"],
        fingerprint: "button-fingerprint",
      },
    ],
  });
}

describe("MacosAccessibilityController", () => {
  it("scopes a fresh tree to one app and leaves the physical cursor unchanged", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const readCursor = vi.fn(async () => ({ x: 700, y: 400 }));
    const controller = new MacosAccessibilityController({
      idFactory: () => "one",
      readCursor,
      runNative: (request) => {
        requests.push(request);
        return request.kind === "snapshot"
          ? nativeSnapshot()
          : JSON.stringify({ ok: true });
      },
    });

    const snapshot = controller.snapshot("TextEdit");
    expect(snapshot).toMatchObject({
      snapshotId: "axs_one",
      app: "TextEdit",
      pid: 42,
    });
    expect(snapshot.elements[0]).toMatchObject({
      id: "axs_one_e1",
      app: "TextEdit",
      role: "AXButton",
      label: "Close",
    });
    expect(JSON.stringify(snapshot)).not.toContain("path");
    expect(JSON.stringify(snapshot)).not.toContain("fingerprint");

    await controller.act({
      snapshotId: snapshot.snapshotId,
      elementId: snapshot.elements[0].id,
      app: "TextEdit",
      action: "press",
    });
    expect(readCursor).toHaveBeenCalledTimes(2);
    expect(requests.at(-1)).toMatchObject({
      kind: "action",
      app: "TextEdit",
      pid: 42,
      path: [0, 2],
      action: "press",
    });
  });

  it("rejects cross-app targeting before invoking the native action", async () => {
    const runNative = vi.fn((request: Record<string, unknown>) =>
      request.kind === "snapshot"
        ? nativeSnapshot()
        : JSON.stringify({ ok: true }),
    );
    const controller = new MacosAccessibilityController({
      idFactory: () => "scope",
      runNative,
    });
    const snapshot = controller.snapshot("TextEdit");

    await expect(
      controller.act({
        snapshotId: snapshot.snapshotId,
        elementId: snapshot.elements[0].id,
        app: "Finder",
        action: "press",
      }),
    ).rejects.toThrow("AX_APP_SCOPE_MISMATCH");
    expect(runNative).toHaveBeenCalledTimes(1);
  });

  it("rejects stale snapshots and consumes a snapshot after one action", async () => {
    let id = 0;
    const controller = new MacosAccessibilityController({
      idFactory: () => `id${++id}`,
      runNative: (request) =>
        request.kind === "snapshot"
          ? nativeSnapshot()
          : JSON.stringify({ ok: true }),
    });
    const first = controller.snapshot("TextEdit");
    const second = controller.snapshot("TextEdit");
    await expect(
      controller.act({
        snapshotId: first.snapshotId,
        elementId: first.elements[0].id,
        app: "TextEdit",
        action: "press",
      }),
    ).rejects.toThrow("AX_STALE_SNAPSHOT");

    const input = {
      snapshotId: second.snapshotId,
      elementId: second.elements[0].id,
      app: "TextEdit",
      action: "press" as const,
    };
    await controller.act(input);
    await expect(controller.act(input)).rejects.toThrow("AX_STALE_SNAPSHOT");
  });

  it("expires element authority and fails closed on manual cursor movement", async () => {
    let now = 1000;
    let cursor = { x: 5, y: 5 };
    const controller = new MacosAccessibilityController({
      now: () => now,
      ttlMs: 50,
      idFactory: () => String(now),
      readCursor: async () => ({ ...cursor }),
      runNative: (request) => {
        if (request.kind === "snapshot") return nativeSnapshot();
        cursor = { x: 99, y: 99 };
        return JSON.stringify({ ok: true });
      },
    });
    const moved = controller.snapshot("TextEdit");
    await expect(
      controller.act({
        snapshotId: moved.snapshotId,
        elementId: moved.elements[0].id,
        app: "TextEdit",
        action: "press",
      }),
    ).rejects.toThrow("USER_INPUT_INTERFERENCE");

    cursor = { x: 5, y: 5 };
    now = 2000;
    const expired = controller.snapshot("TextEdit");
    now += 51;
    await expect(
      controller.act({
        snapshotId: expired.snapshotId,
        elementId: expired.elements[0].id,
        app: "TextEdit",
        action: "press",
      }),
    ).rejects.toThrow("AX_STALE_SNAPSHOT");
  });
});
