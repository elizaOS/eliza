// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createUsbInstallerHandler } from "../../server";
import type { WritePlan } from "../backend/types";

afterEach(() => vi.unstubAllEnvs());
it("bounds concurrent pending plan admission and reclaims expired entries", async () => {
  vi.stubEnv("ELIZAOS_USB_ENABLE_RAW_WRITE", "1");
  let now = 0;
  const plan: WritePlan = {
    request: {
      driveId: "usb",
      imageId: "image",
      dryRun: false,
      acknowledgeDataLoss: true,
    },
    drive: {
      id: "usb",
      name: "Fixture",
      devicePath: "/dev/fixture",
      sizeBytes: 4096,
      bus: "usb",
      platform: "linux",
      safety: "safe-removable",
    },
    image: {
      id: "image",
      label: "Fixture",
      version: "1",
      channel: "beta",
      architecture: "arm64",
      buildId: "fixture",
      publishedAt: "2026-01-01",
      url: "https://example.test/image.iso",
      checksumSha256: "ab".repeat(32),
      sizeBytes: 256,
      minUsbSizeBytes: 4096,
      manifestVersion: 1,
    },
    steps: [],
    privilegedWriteImplemented: true,
  };
  const handler = createUsbInstallerHandler(
    {
      listRemovableDrives: async () => [plan.drive],
      listImages: async () => [plan.image],
      createWritePlan: async () => structuredClone(plan),
    },
    { now: () => now, planTtlMs: 10 },
  );
  const request = () =>
    handler(
      new Request("http://127.0.0.1:3742/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(plan.request),
      }),
    );
  const responses = await Promise.all(Array.from({ length: 9 }, request));
  expect(responses.filter((response) => response.status === 200)).toHaveLength(
    8,
  );
  expect(responses.filter((response) => !response.ok)).toHaveLength(1);
  now = 11;
  expect((await request()).status).toBe(200);
});

it.each([
  null,
  {},
  {
    driveId: "usb",
    imageId: "image",
    dryRun: "false",
    acknowledgeDataLoss: true,
  },
])(
  "rejects malformed requests before consulting the backend: %j",
  async (body) => {
    const createWritePlan = vi.fn(async () => {
      throw new Error("Must not plan");
    });
    const handler = createUsbInstallerHandler({
      listRemovableDrives: async () => [],
      listImages: async () => [],
      createWritePlan,
    });
    const response = await handler(
      new Request("http://127.0.0.1:3742/plan", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(400);
    expect(createWritePlan).not.toHaveBeenCalled();
  },
);
