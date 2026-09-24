// Exercises USB installer server and dry-run application behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpUsbInstallerBackend } from "../backend/http-backend";
import type { InstallerStepId, WritePlan } from "../backend/types";

const plan = {
  planId: "plan-1",
  request: {
    driveId: "usb",
    imageId: "image",
    dryRun: false,
    acknowledgeDataLoss: true,
  },
  drive: {
    id: "usb",
    name: "USB",
    devicePath: "/dev/sdb",
    sizeBytes: 16 * 1024 ** 3,
    bus: "usb",
    platform: "linux",
    safety: "safe-removable",
  },
  image: {
    id: "image",
    label: "elizaOS",
    version: "stable",
    channel: "stable",
    architecture: "x86_64",
    buildId: "stable",
    publishedAt: "2026-05-19T00:00:00.000Z",
    url: "https://download.elizaos.ai/elizaos.iso",
    checksumSha256:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sizeBytes: 4 * 1024 ** 3,
    minUsbSizeBytes: 8 * 1024 ** 3,
    manifestVersion: 1,
  },
  steps: [],
  privilegedWriteImplemented: true,
} satisfies WritePlan;

function streamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HttpUsbInstallerBackend", () => {
  it("parses fragmented server-sent events", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      streamResponse([
        'data: {"stepId":"write","progress":0.',
        '5}\n\ndata: {"done":true}\n\n',
      ]),
    );
    const backend = new HttpUsbInstallerBackend();
    const progress: Array<[string, number]> = [];

    await backend.executeWritePlan(plan, (step, pct) =>
      progress.push([step, pct]),
    );

    expect(progress).toEqual([["write", 0.5]]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/execute",
      expect.objectContaining({
        body: JSON.stringify({ planId: "plan-1" }),
      }),
    );
  });

  it("preserves structured backend error names", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { name: "ChecksumMismatchError", error: "Checksum failed" },
        { status: 409 },
      ),
    );
    const backend = new HttpUsbInstallerBackend();

    await expect(backend.listImages()).rejects.toMatchObject({
      name: "ChecksumMismatchError",
      message: "Checksum failed",
    });
  });

  it.each([
    [
      "missing terminal",
      ['data: {"stepId":"write","progress":0.5}\n\n'],
      "without a terminal",
    ],
    ["truncated terminal", ['data: {"done":true}'], "truncated SSE"],
    [
      "duplicate terminal",
      ['data: {"done":true}\n\ndata: {"done":true}\n\n'],
      "event after a terminal",
    ],
    [
      "contradictory terminal",
      ['data: {"done":true,"error":"bad"}\n\n'],
      "contradictory done",
    ],
    ["malformed JSON", ["data: {nope}\n\n"], "malformed JSON"],
  ])("rejects %s event streams", async (_label, chunks, message) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(streamResponse(chunks));
    const backend = new HttpUsbInstallerBackend();

    await expect(backend.executeWritePlan(plan, () => {})).rejects.toThrow(
      message,
    );
  });

  it("does not report progress after a terminal event", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      streamResponse([
        'data: {"done":true}\n\ndata: {"stepId":"write","progress":0.75}\n\n',
      ]),
    );
    const backend = new HttpUsbInstallerBackend();
    const progress: Array<{ stepId: InstallerStepId; value: number }> = [];

    await expect(
      backend.executeWritePlan(plan, (stepId, value) =>
        progress.push({ stepId, value }),
      ),
    ).rejects.toThrow("event after a terminal");
    expect(progress).toEqual([]);
  });

  it("preserves the typed incomplete-media cancellation terminal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      streamResponse([
        'data: {"cancelled":true,"name":"WriteCancelledError","error":"Write cancelled. Media is incomplete and must be rewritten or restored before use."}\n\n',
      ]),
    );
    const backend = new HttpUsbInstallerBackend();

    await expect(
      backend.executeWritePlan(plan, () => {}),
    ).rejects.toMatchObject({
      name: "WriteCancelledError",
      message: expect.stringContaining("Media is incomplete"),
    });
  });

  it("requests cancellation using only the server-owned plan id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ cancelled: true }),
    );
    const backend = new HttpUsbInstallerBackend();

    await backend.cancelWritePlan(plan);

    expect(fetch).toHaveBeenCalledWith(
      "/api/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ planId: "plan-1" }),
      }),
    );
  });
});
