// Exercises USB installer server and dry-run application behavior.
import { afterEach, describe, expect, it } from "vitest";
import { createUsbInstallerHandler } from "../../server";
import type {
  ElizaOsImage,
  InstallerStepId,
  RemovableDrive,
  UsbInstallerBackend,
  WriteExecutionOptions,
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

const canonicalRawImage: ElizaOsImage = {
  ...image,
  url: "https://download.elizaos.ai/elizaos.raw.zst",
  signatureUrl: "https://download.elizaos.ai/elizaos.raw.zst.sig",
  format: "raw.zst",
  checksumSha256: trustedChecksum,
  sha256Compressed: trustedChecksum,
  sha256Expanded: "fedcba9876543210".repeat(4),
  compressedSize: 4 * 1024 ** 3,
  expandedSize: 6 * 1024 ** 3,
  sizeBytes: 4 * 1024 ** 3,
  minDeviceBytes: 8 * 1024 ** 3,
  minUsbSizeBytes: 8 * 1024 ** 3,
};

class FakeBackend implements UsbInstallerBackend {
  public createRequests: WriteRequest[] = [];
  public executedPlan: WritePlan | null = null;

  constructor(
    public currentDrive: RemovableDrive = drive,
    public currentImage: ElizaOsImage = image,
    public canonicalRawZstdSupported = false,
  ) {}

  async listRemovableDrives(): Promise<RemovableDrive[]> {
    return [this.currentDrive];
  }

  async listImages(): Promise<ElizaOsImage[]> {
    return [this.currentImage];
  }

  async createWritePlan(request: WriteRequest): Promise<WritePlan> {
    this.createRequests.push(request);
    assertDriveMatchesExpected(request, this.currentDrive);
    return {
      request,
      drive: this.currentDrive,
      image: this.currentImage,
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

class CancellableBackend extends FakeBackend {
  readonly canonicalWriteCancellationSupported = true;
  readonly started: Promise<void>;
  readonly abortReceived: Promise<void>;
  private markStarted!: () => void;
  private markAbortReceived!: () => void;
  private readonly terminationConfirmed: Promise<void>;
  private confirm!: () => void;

  constructor() {
    super(drive, canonicalRawImage, true);
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
    this.abortReceived = new Promise((resolve) => {
      this.markAbortReceived = resolve;
    });
    this.terminationConfirmed = new Promise((resolve) => {
      this.confirm = resolve;
    });
  }

  confirmTermination(): void {
    this.confirm();
  }

  override async executeWritePlan(
    plan: WritePlan,
    _onProgress: (step: InstallerStepId, progress: number) => void,
    options: WriteExecutionOptions = {},
  ): Promise<void> {
    this.executedPlan = plan;
    this.markStarted();
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      options.signal?.addEventListener(
        "abort",
        () => {
          this.markAbortReceived();
          void this.terminationConfirmed.then(() =>
            reject(options.signal?.reason),
          );
        },
        { once: true },
      );
    });
  }
}

class ResolvingOnAbortBackend extends FakeBackend {
  readonly canonicalWriteCancellationSupported = true;
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    super(drive, canonicalRawImage, true);
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  override async executeWritePlan(
    plan: WritePlan,
    _onProgress: (step: InstallerStepId, progress: number) => void,
    options: WriteExecutionOptions = {},
  ): Promise<void> {
    this.executedPlan = plan;
    this.markStarted();
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) {
        resolve();
        return;
      }
      options.signal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }
}

class AliasedTargetBackend extends CancellableBackend {
  readonly primaryDrive: RemovableDrive = {
    ...drive,
    stableId: "linux:shared-hardware-id",
  };
  readonly aliasDrive: RemovableDrive = {
    ...drive,
    id: "usb-by-id",
    devicePath: "/dev/disk/by-id/usb-shared-hardware-id",
    stableId: "linux:shared-hardware-id",
  };

  override async listRemovableDrives(): Promise<RemovableDrive[]> {
    return [this.primaryDrive, this.aliasDrive];
  }

  override async createWritePlan(request: WriteRequest): Promise<WritePlan> {
    this.createRequests.push(request);
    const selectedDrive = [this.primaryDrive, this.aliasDrive].find(
      (candidate) => candidate.id === request.driveId,
    );
    if (!selectedDrive) throw new Error(`Unknown drive id: ${request.driveId}`);
    assertDriveMatchesExpected(request, selectedDrive);
    return {
      request,
      drive: selectedDrive,
      image: canonicalRawImage,
      steps: [],
      privilegedWriteImplemented: true,
    };
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

  it("permits canonical raw.zst plans only for an explicitly capable backend", async () => {
    process.env.ELIZAOS_USB_ENABLE_RAW_WRITE = "1";
    const requestPlan = () =>
      request("/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          driveId: drive.id,
          imageId: canonicalRawImage.id,
          dryRun: false,
          acknowledgeDataLoss: true,
        }),
      });

    const blocked = await createUsbInstallerHandler(
      new FakeBackend(drive, canonicalRawImage, false),
    )(requestPlan());
    expect(blocked.status).toBe(500);
    await expect(json(blocked)).resolves.toMatchObject({
      error: expect.stringContaining("streaming decompression"),
    });

    const accepted = await createUsbInstallerHandler(
      new FakeBackend(drive, canonicalRawImage, true),
    )(requestPlan());
    expect(accepted.status).toBe(200);
    await expect(json(accepted)).resolves.toMatchObject({
      planId: expect.any(String),
      cancellationSupported: false,
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

  it("cancels an active write, reports incomplete media, and consumes the plan", async () => {
    process.env.ELIZAOS_USB_ENABLE_RAW_WRITE = "1";
    const backend = new CancellableBackend();
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
    expect(plan.cancellationSupported).toBe(true);
    const secondPlanRes = await handler(
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
    const secondPlan = (await secondPlanRes.json()) as WritePlan;
    expect(secondPlan.planId).not.toBe(plan.planId);

    const executeRes = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.planId }),
      }),
    );
    await backend.started;
    const sameTargetRes = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: secondPlan.planId }),
      }),
    );
    expect(sameTargetRes.status).toBe(409);
    await expect(json(sameTargetRes)).resolves.toMatchObject({
      error: "Another write is already active for this target.",
    });

    const duplicateRes = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.planId }),
      }),
    );
    expect(duplicateRes.status).toBe(409);
    await expect(json(duplicateRes)).resolves.toMatchObject({
      error: "Write plan is already executing.",
    });

    const cancelRes = await handler(
      request("/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.planId }),
      }),
    );

    expect(cancelRes.status).toBe(200);
    await expect(json(cancelRes)).resolves.toEqual({ cancelled: true });
    await backend.abortReceived;
    const lockedAfterCancelRes = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: secondPlan.planId }),
      }),
    );
    expect(lockedAfterCancelRes.status).toBe(409);
    await expect(json(lockedAfterCancelRes)).resolves.toMatchObject({
      error: "Another write is already active for this target.",
    });
    backend.confirmTermination();
    const executionEvents = await executeRes.text();
    expect(executionEvents).toContain('"cancelled":true');
    expect(executionEvents).toContain('"name":"AbortError"');
    expect(executionEvents).toContain("Media is incomplete");
    expect(executionEvents).not.toContain('"done":true');

    const replayRes = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.planId }),
      }),
    );
    expect(replayRes.status).toBe(409);
    await expect(json(replayRes)).resolves.toMatchObject({
      error: expect.stringContaining("Unknown or expired write plan"),
    });

    const staleSecondRes = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: secondPlan.planId }),
      }),
    );
    expect(staleSecondRes.status).toBe(409);
    await expect(json(staleSecondRes)).resolves.toMatchObject({
      error: expect.stringContaining("Unknown or expired write plan"),
    });
  });

  it("rejects cancellation for a plan that is not actively executing", async () => {
    const handler = createUsbInstallerHandler(new FakeBackend());
    const res = await handler(
      request("/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: "not-active" }),
      }),
    );

    expect(res.status).toBe(409);
    await expect(json(res)).resolves.toMatchObject({
      error: "Write plan is not actively executing.",
    });
  });

  it("reports cancellation when the backend resolves after observing abort", async () => {
    process.env.ELIZAOS_USB_ENABLE_RAW_WRITE = "1";
    const backend = new ResolvingOnAbortBackend();
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
    const executeRes = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.planId }),
      }),
    );
    await backend.started;

    const cancelRes = await handler(
      request("/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.planId }),
      }),
    );

    expect(cancelRes.status).toBe(200);
    await expect(json(cancelRes)).resolves.toEqual({ cancelled: true });
    const executionEvents = await executeRes.text();
    expect(executionEvents).toContain('"cancelled":true');
    expect(executionEvents).toContain("Media is incomplete");
    expect(executionEvents).not.toContain('"done":true');
  });

  it("locks distinct device-path aliases that share a stable target identity", async () => {
    process.env.ELIZAOS_USB_ENABLE_RAW_WRITE = "1";
    const backend = new AliasedTargetBackend();
    const handler = createUsbInstallerHandler(backend);
    const createPlan = async (driveId: string) => {
      const response = await handler(
        request("/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            driveId,
            imageId: image.id,
            dryRun: false,
            acknowledgeDataLoss: true,
          }),
        }),
      );
      return (await response.json()) as WritePlan;
    };
    const primaryPlan = await createPlan(backend.primaryDrive.id);
    const aliasPlan = await createPlan(backend.aliasDrive.id);
    expect(primaryPlan.drive.devicePath).not.toBe(aliasPlan.drive.devicePath);
    expect(primaryPlan.drive.stableId).toBe(aliasPlan.drive.stableId);

    const executionResponse = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: primaryPlan.planId }),
      }),
    );
    await backend.started;
    const aliasExecutionResponse = await handler(
      request("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: aliasPlan.planId }),
      }),
    );

    expect(aliasExecutionResponse.status).toBe(409);
    await expect(json(aliasExecutionResponse)).resolves.toMatchObject({
      error: "Another write is already active for this target.",
    });

    await handler(
      request("/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: primaryPlan.planId }),
      }),
    );
    backend.confirmTermination();
    await executionResponse.text();
  });
});
