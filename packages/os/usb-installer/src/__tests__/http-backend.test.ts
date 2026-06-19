import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpUsbInstallerBackend } from "../backend/http-backend";
import type { WritePlan } from "../backend/types";

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
});
