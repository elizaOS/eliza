import { afterEach, describe, expect, it } from "vitest";
import { createUsbInstallerHandler } from "../../server";
import type {
  ElizaOsImage,
  InstallerStepId,
  RemovableDrive,
  UsbInstallerBackend,
  WritePlan,
  WriteRequest,
} from "../backend/types";
import { assertDriveMatchesExpected } from "../backend/write-safety";

const trustedChecksum =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const drive: RemovableDrive = {
  id: "sdb",
  name: "Test USB",
  devicePath: "/dev/sdb",
  sizeBytes: 16 * 1024 ** 3,
  bus: "usb",
  platform: "linux",
  safety: "safe-removable",
};

const image: ElizaOsImage = {
  id: "elizaos",
  label: "elizaOS",
  version: "stable",
  channel: "stable",
  architecture: "x86_64",
  buildId: "stable",
  publishedAt: "2026-05-19T00:00:00.000Z",
  url: "https://download.elizaos.ai/elizaos.iso",
  checksumSha256: trustedChecksum,
  sizeBytes: 4 * 1024 ** 3,
  minUsbSizeBytes: 8 * 1024 ** 3,
  manifestVersion: 1,
};

class FakeBackend implements UsbInstallerBackend {
  public createRequests: WriteRequest[] = [];
  public executedPlan: WritePlan | null = null;

  constructor(public currentDrive: RemovableDrive = drive) {}

  async listRemovableDrives(): Promise<RemovableDrive[]> {
    return [this.currentDrive];
  }

  async listImages(): Promise<ElizaOsImage[]> {
    return [image];
  }

  async createWritePlan(request: WriteRequest): Promise<WritePlan> {
    this.createRequests.push(request);
    assertDriveMatchesExpected(request, this.currentDrive);
    return {
      request,
      drive: this.currentDrive,
      image,
      steps: [],
      privilegedWriteImplemented: true,
    };
  }

  async executeWritePlan(
    plan: WritePlan,
    onProgress: (step: InstallerStepId, progress: number) => void,
  ): Promise<void> {
    this.executedPlan = plan;
    onProgress("write", 1);
  }
}

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", "http://127.0.0.1:5174");
  return new Request(`http://127.0.0.1:3742${path}`, {
    ...init,
    headers,
  });
}

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

afterEach(() => {
  delete process.env.ELIZAOS_USB_ENABLE_RAW_WRITE;
});

describe("USB installer server", () => {
  it("rejects non-local browser origins", async () => {
    const handler = createUsbInstallerHandler(new FakeBackend());
    const res = await handler(
      new Request("http://127.0.0.1:3742/drives", {
        headers: { origin: "https://evil.example" },
      }),
    );

    expect(res.status).toBe(403);
    await expect(json(res)).resolves.toMatchObject({
      name: "Error",
      error: "Origin is not allowed.",
    });
  });

  it("rejects unlisted localhost browser origins", async () => {
    const handler = createUsbInstallerHandler(new FakeBackend());
    const res = await handler(
      new Request("http://127.0.0.1:3742/drives", {
        headers: { origin: "http://127.0.0.1:9999" },
      }),
    );

    expect(res.status).toBe(403);
    await expect(json(res)).resolves.toMatchObject({
      name: "Error",
      error: "Origin is not allowed.",
    });
  });

  it("keeps raw writes disabled unless explicitly enabled", async () => {
    const handler = createUsbInstallerHandler(new FakeBackend());
    const res = await handler(
      request("/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          driveId: drive.id,
          imageId: image.id,
          dryRun: false,
          acknowledgeDataLoss: true,
        }),
      }),
    );

    expect(res.status).toBe(500);
    await expect(json(res)).resolves.toMatchObject({
      error: expect.stringContaining("Raw USB writes are disabled"),
    });
  });

  it("requires a server plan id instead of accepting forged execute payloads", async () => {
    process.env.ELIZAOS_USB_ENABLE_RAW_WRITE = "1";
    const handler = createUsbInstallerHandler(new FakeBackend());
    const res = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan: {
            drive: { devicePath: "/dev/sda", safety: "safe-removable" },
          },
        }),
      }),
    );

    expect(res.status).toBe(400);
    await expect(json(res)).resolves.toMatchObject({
      error: expect.stringContaining("Missing planId"),
    });
  });

  it("rebuilds the plan server-side before executing", async () => {
    process.env.ELIZAOS_USB_ENABLE_RAW_WRITE = "1";
    const backend = new FakeBackend();
    const handler = createUsbInstallerHandler(backend);

    const planRes = await handler(
      request("/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          driveId: drive.id,
          imageId: image.id,
          dryRun: false,
          acknowledgeDataLoss: true,
        }),
      }),
    );
    const plan = (await planRes.json()) as WritePlan;
    expect(plan.planId).toEqual(expect.any(String));

    const executeRes = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.planId }),
      }),
    );
    const text = await executeRes.text();

    expect(text).toContain('"done":true');
    expect(backend.executedPlan?.drive.devicePath).toBe(drive.devicePath);
    expect(backend.createRequests.at(-1)?.expectedDrive).toMatchObject({
      devicePath: drive.devicePath,
      sizeBytes: drive.sizeBytes,
    });
  });

  it("expires stored write plans before execution", async () => {
    process.env.ELIZAOS_USB_ENABLE_RAW_WRITE = "1";
    const backend = new FakeBackend();
    let now = 1_000;
    const handler = createUsbInstallerHandler(backend, {
      now: () => now,
      planTtlMs: 100,
    });

    const planRes = await handler(
      request("/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          driveId: drive.id,
          imageId: image.id,
          dryRun: false,
          acknowledgeDataLoss: true,
        }),
      }),
    );
    const plan = (await planRes.json()) as WritePlan;
    expect(plan.planId).toEqual(expect.any(String));

    now = 1_101;
    const executeRes = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.planId }),
      }),
    );
    const text = await executeRes.text();

    expect(text).toContain("Unknown or expired write plan");
    expect(backend.executedPlan).toBeNull();
  });

  it("blocks execution if the target drive changes after planning", async () => {
    process.env.ELIZAOS_USB_ENABLE_RAW_WRITE = "1";
    const backend = new FakeBackend();
    const handler = createUsbInstallerHandler(backend);

    const planRes = await handler(
      request("/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          driveId: drive.id,
          imageId: image.id,
          dryRun: false,
          acknowledgeDataLoss: true,
        }),
      }),
    );
    const plan = (await planRes.json()) as WritePlan;

    backend.currentDrive = {
      ...drive,
      devicePath: "/dev/sdc",
    };

    const executeRes = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.planId }),
      }),
    );
    const text = await executeRes.text();

    expect(text).toContain("Selected drive changed before write");
    expect(backend.executedPlan).toBeNull();
  });
});
