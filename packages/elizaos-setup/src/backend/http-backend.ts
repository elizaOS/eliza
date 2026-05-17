import type {
  AospBuild,
  AospFlasherBackend,
  ConnectedDevice,
  DeviceSpecs,
  FlashPlan,
  FlashRequest,
  FlashStepId,
  FlashStepStatus,
} from "./types";

const MAX_SSE_BYTES = 50 * 1024 * 1024; // 50 MB hard cap

export class InvalidServerResponseError extends Error {
  constructor(
    public readonly raw: unknown,
    public readonly parseError: string,
  ) {
    super(`Server returned an invalid response: ${parseError}`);
    this.name = "InvalidServerResponseError";
  }
}

export class SseResponseTooLargeError extends Error {
  constructor(byteCount: number) {
    super(
      `SSE stream exceeded ${MAX_SSE_BYTES} byte cap (read ${byteCount} bytes). Aborting.`,
    );
    this.name = "SseResponseTooLargeError";
  }
}

// ---------------------------------------------------------------------------
// Validators — small, dependency-free shape checks
// ---------------------------------------------------------------------------

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateConnectedDevice(v: unknown): ConnectedDevice {
  if (!isObject(v)) throw new Error("device: not an object");
  if (!isString(v.serial)) throw new Error("device.serial must be a string");
  if (!isString(v.model)) throw new Error("device.model must be a string");
  if (!isString(v.codename))
    throw new Error("device.codename must be a string");
  if (!isString(v.state)) throw new Error("device.state must be a string");
  return v as unknown as ConnectedDevice;
}

function validateDeviceSpecs(v: unknown): DeviceSpecs {
  if (!isObject(v)) throw new Error("specs: not an object");
  if (!isNumber(v.storageAvailableBytes))
    throw new Error("specs.storageAvailableBytes must be a number");
  if (!isNumber(v.storageTotalBytes))
    throw new Error("specs.storageTotalBytes must be a number");
  if (!isString(v.androidVersion))
    throw new Error("specs.androidVersion must be a string");
  if (!isString(v.abi)) throw new Error("specs.abi must be a string");
  if (!isBoolean(v.supportedByElizaOs))
    throw new Error("specs.supportedByElizaOs must be a boolean");
  return v as unknown as DeviceSpecs;
}

function validateBuild(v: unknown): AospBuild {
  if (!isObject(v)) throw new Error("build: not an object");
  if (!isString(v.id)) throw new Error("build.id must be a string");
  if (!isString(v.label)) throw new Error("build.label must be a string");
  if (!isString(v.version)) throw new Error("build.version must be a string");
  if (!isString(v.manifestUrl))
    throw new Error("build.manifestUrl must be a string");
  if (!isNumber(v.sizeBytes))
    throw new Error("build.sizeBytes must be a number");
  return v as unknown as AospBuild;
}

function validateFlashPlan(v: unknown): FlashPlan {
  if (!isObject(v)) throw new Error("plan: not an object");
  validateConnectedDevice(v.device);
  validateBuild(v.build);
  if (!Array.isArray(v.steps)) throw new Error("plan.steps must be an array");
  if (!isObject(v.request))
    throw new Error("plan.request must be an object (FlashRequest)");
  return v as unknown as FlashPlan;
}

type ExecuteFrame =
  | { done: true }
  | { error: string }
  | { stepId: FlashStepId; status: FlashStepStatus; detail: string };

function validateExecuteFrame(v: unknown): ExecuteFrame {
  if (!isObject(v)) throw new Error("frame: not an object");
  if (v.done === true) return { done: true };
  if (isString(v.error)) return { error: v.error };
  if (!isString(v.stepId)) throw new Error("frame.stepId must be a string");
  if (!isString(v.status)) throw new Error("frame.status must be a string");
  if (!isString(v.detail)) throw new Error("frame.detail must be a string");
  return {
    stepId: v.stepId as FlashStepId,
    status: v.status as FlashStepStatus,
    detail: v.detail,
  };
}

// ---------------------------------------------------------------------------
// HttpAospFlasherBackend
// ---------------------------------------------------------------------------

export class HttpAospFlasherBackend implements AospFlasherBackend {
  private readonly base: string;

  constructor(base = "/api") {
    this.base = base;
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) {
      throw new Error(`GET ${path} failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`POST ${path} failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  async listConnectedDevices(): Promise<ConnectedDevice[]> {
    const raw = await this.getJson("/devices");
    if (!Array.isArray(raw)) {
      throw new InvalidServerResponseError(raw, "/devices: expected array");
    }
    try {
      return raw.map(validateConnectedDevice);
    } catch (err) {
      throw new InvalidServerResponseError(
        raw,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async getDeviceSpecs(serial: string): Promise<DeviceSpecs> {
    const raw = await this.postJson("/specs", { serial });
    try {
      return validateDeviceSpecs(raw);
    } catch (err) {
      throw new InvalidServerResponseError(
        raw,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async listBuilds(): Promise<AospBuild[]> {
    const raw = await this.getJson("/builds");
    if (!Array.isArray(raw)) {
      throw new InvalidServerResponseError(raw, "/builds: expected array");
    }
    try {
      return raw.map(validateBuild);
    } catch (err) {
      throw new InvalidServerResponseError(
        raw,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async createFlashPlan(request: FlashRequest): Promise<FlashPlan> {
    const raw = await this.postJson("/plan", request);
    try {
      return validateFlashPlan(raw);
    } catch (err) {
      throw new InvalidServerResponseError(
        raw,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async executeFlashPlan(
    plan: FlashPlan,
    onProgress: (
      stepId: FlashStepId,
      status: FlashStepStatus,
      detail: string,
    ) => void,
  ): Promise<void> {
    const res = await fetch(`${this.base}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`POST /execute failed: HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytesConsumed = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        bytesConsumed += value.byteLength;
        if (bytesConsumed > MAX_SSE_BYTES) {
          await reader.cancel();
          throw new SseResponseTooLargeError(bytesConsumed);
        }

        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const dataLine = frame
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (!dataLine) continue;

          const json = dataLine.slice("data: ".length);
          let parsed: unknown;
          try {
            parsed = JSON.parse(json);
          } catch (err) {
            throw new InvalidServerResponseError(
              json,
              err instanceof Error ? err.message : String(err),
            );
          }

          let msg: ExecuteFrame;
          try {
            msg = validateExecuteFrame(parsed);
          } catch (err) {
            throw new InvalidServerResponseError(
              parsed,
              err instanceof Error ? err.message : String(err),
            );
          }

          if ("error" in msg) {
            throw new Error(msg.error);
          }
          if ("done" in msg) {
            return;
          }
          onProgress(msg.stepId, msg.status, msg.detail);
        }
      }
    } finally {
      // Best-effort release of the reader if we're exiting via an error path.
      reader.releaseLock?.();
    }
  }
}
