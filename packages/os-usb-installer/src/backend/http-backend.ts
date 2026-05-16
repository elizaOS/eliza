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
    if (!res.ok) throw new Error(`Backend error: ${res.status}`);
    return res.json() as Promise<RemovableDrive[]>;
  }

  async listImages(): Promise<ElizaOsImage[]> {
    const res = await fetch(`${SERVER}/images`);
    if (!res.ok) throw new Error(`Backend error: ${res.status}`);
    return res.json() as Promise<ElizaOsImage[]>;
  }

  async createWritePlan(request: WriteRequest): Promise<WritePlan> {
    const res = await fetch(`${SERVER}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) throw new Error(`Backend error: ${res.status}`);
    return res.json() as Promise<WritePlan>;
  }

  async executeWritePlan(
    plan: WritePlan,
    onProgress: (stepId: InstallerStepId, progress: number) => void,
  ): Promise<void> {
    const res = await fetch(`${SERVER}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    if (!res.ok) throw new Error(`Backend error: ${res.status}`);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = JSON.parse(line.slice(6)) as {
          stepId?: InstallerStepId;
          progress?: number;
          done?: boolean;
          error?: string;
        };
        if (data.error) throw new Error(data.error);
        if (data.done) return;
        if (data.stepId !== undefined && data.progress !== undefined) {
          onProgress(data.stepId, data.progress);
        }
      }
    }
  }
}
