import type {
  ElizaOsImage,
  InstallerStepId,
  RemovableDrive,
  UsbInstallerBackend,
  WritePlan,
  WriteRequest,
} from "./types";

// Use the Vite proxy prefix when running in the browser dev server,
// so all requests go through /api/* → localhost:3742 — no CORS needed.
const SERVER = "/api";

export class HttpUsbInstallerBackend implements UsbInstallerBackend {
  async listRemovableDrives(): Promise<RemovableDrive[]> {
    const res = await fetch(`${SERVER}/drives`);
    if (!res.ok) throw await backendError(res);
    return res.json() as Promise<RemovableDrive[]>;
  }

  async listImages(): Promise<ElizaOsImage[]> {
    const res = await fetch(`${SERVER}/images`);
    if (!res.ok) throw await backendError(res);
    return res.json() as Promise<ElizaOsImage[]>;
  }

  async createWritePlan(request: WriteRequest): Promise<WritePlan> {
    const res = await fetch(`${SERVER}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) throw await backendError(res);
    return res.json() as Promise<WritePlan>;
  }

  async executeWritePlan(
    plan: WritePlan,
    onProgress: (stepId: InstallerStepId, progress: number) => void,
  ): Promise<void> {
    if (!plan.planId) {
      throw new Error("Write plan is missing a server plan id.");
    }

    const res = await fetch(`${SERVER}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: plan.planId }),
    });
    if (!res.ok) throw await backendError(res);
    if (!res.body) throw new Error("Backend response did not include a body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (pending.trim()) {
          handleSseMessage(pending, onProgress);
        }
        break;
      }

      pending += decoder.decode(value, { stream: true });
      const messages = pending.split(/\n\n/);
      pending = messages.pop() ?? "";

      for (const message of messages) {
        if (handleSseMessage(message, onProgress)) return;
      }
    }
  }
}

async function backendError(res: Response): Promise<Error> {
  try {
    const data = (await res.json()) as { error?: string; name?: string };
    const err = new Error(data.error ?? `Backend error: ${res.status}`);
    err.name = data.name ?? "BackendError";
    return err;
  } catch {
    return new Error(`Backend error: ${res.status}`);
  }
}

function handleSseMessage(
  message: string,
  onProgress: (stepId: InstallerStepId, progress: number) => void,
): boolean {
  for (const line of message.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = JSON.parse(line.slice(6)) as {
      stepId?: InstallerStepId;
      progress?: number;
      done?: boolean;
      error?: string;
      name?: string;
    };
    if (data.error) {
      const err = new Error(data.error);
      err.name = data.name ?? "BackendError";
      throw err;
    }
    if (data.done) return true;
    if (data.stepId !== undefined && data.progress !== undefined) {
      onProgress(data.stepId, data.progress);
    }
  }
  return false;
}
