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

// ---------------------------------------------------------------------------
// HttpAospFlasherBackend
//
// Calls the Bun HTTP server (server.ts) over localhost. Used when running in
// the browser (Vite dev / Electrobun renderer) where native process spawning
// is unavailable.
// ---------------------------------------------------------------------------

export class HttpAospFlasherBackend implements AospFlasherBackend {
  private readonly base: string;

  constructor(base = "/api") {
    this.base = base;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) {
      throw new Error(`GET ${path} failed: HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`POST ${path} failed: HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async listConnectedDevices(): Promise<ConnectedDevice[]> {
    return this.get<ConnectedDevice[]>("/devices");
  }

  async getDeviceSpecs(serial: string): Promise<DeviceSpecs> {
    return this.post<DeviceSpecs>("/specs", { serial });
  }

  async listBuilds(): Promise<AospBuild[]> {
    return this.get<AospBuild[]>("/builds");
  }

  async createFlashPlan(request: FlashRequest): Promise<FlashPlan> {
    return this.post<FlashPlan>("/plan", request);
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by double newline
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const dataLine = frame
          .split("\n")
          .find((l) => l.startsWith("data: "));
        if (!dataLine) continue;

        const json = dataLine.slice("data: ".length);
        const msg = JSON.parse(json) as
          | { done: true }
          | { error: string }
          | { stepId: FlashStepId; status: FlashStepStatus; detail: string };

        if ("error" in msg) {
          throw new Error(msg.error);
        }
        if ("done" in msg) {
          return;
        }
        onProgress(msg.stepId, msg.status, msg.detail);
      }
    }
  }
}
