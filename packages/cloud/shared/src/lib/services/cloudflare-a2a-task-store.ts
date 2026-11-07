import { createHash } from "node:crypto";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { getCloudAwareEnv, getCloudBinding } from "../runtime/cloud-bindings";
import type { TaskStoreEntry } from "./a2a-task-store";

export class A2AStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2AStateError";
  }
}
export interface A2ATaskSnapshot {
  taskId: string;
  entry: TaskStoreEntry;
  score: number;
  expiresAt: number;
}
export class CloudflareA2ATaskStore {
  constructor(private readonly namespace: RuntimeDurableObjectNamespace) {}
  private async call(organizationId: string, input: object): Promise<unknown> {
    if (!organizationId) throw new A2AStateError("Organization is required");
    const name = `a2a-v1:${createHash("sha256").update(organizationId).digest("hex")}`;
    const response = await this.namespace.getByName(name).fetch("https://a2a-state.internal/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, organizationId }),
    });
    if (!response.ok) throw new A2AStateError(`A2A state rejected operation (${response.status})`);
    return response.json();
  }
  private async read(
    taskId: string,
    organizationId: string,
  ): Promise<{ entry: TaskStoreEntry; version: string } | null> {
    const result = await this.call(organizationId, { operation: "get", taskId });
    if (result === null) return null;
    if (
      !result ||
      typeof result !== "object" ||
      !("version" in result) ||
      typeof result.version !== "string" ||
      !("entry" in result) ||
      !result.entry ||
      typeof result.entry !== "object" ||
      !("organizationId" in result.entry) ||
      result.entry.organizationId !== organizationId
    )
      throw new A2AStateError("Invalid task receipt");
    return result as { entry: TaskStoreEntry; version: string };
  }
  async get(taskId: string, organizationId: string): Promise<TaskStoreEntry | null> {
    return (await this.read(taskId, organizationId))?.entry ?? null;
  }
  async set(taskId: string, entry: TaskStoreEntry): Promise<void> {
    const result = await this.call(entry.organizationId, { operation: "set", taskId, entry });
    if (result !== true) throw new A2AStateError("Task write not acknowledged");
  }
  async update(
    taskId: string,
    organizationId: string,
    updater: (entry: TaskStoreEntry) => TaskStoreEntry,
  ): Promise<TaskStoreEntry | null> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const current = await this.read(taskId, organizationId);
      if (!current) return null;
      const entry = updater({ ...current.entry, updatedAt: new Date().toISOString() });
      const result = await this.call(organizationId, {
        operation: "set",
        taskId,
        entry,
        version: current.version,
      });
      if (result === true) return entry;
      if (result !== false) throw new A2AStateError("Invalid task update receipt");
    }
    throw new A2AStateError("A2A task update contention limit reached");
  }
  async delete(taskId: string, organizationId: string): Promise<boolean> {
    const result = await this.call(organizationId, { operation: "delete", taskId });
    if (typeof result !== "boolean") throw new A2AStateError("Invalid task deletion receipt");
    return result;
  }
  async listByOrganization(organizationId: string, limit = 50): Promise<TaskStoreEntry[]> {
    const result = await this.call(organizationId, { operation: "list", limit });
    if (
      !Array.isArray(result) ||
      result.some((row) => !row || typeof row !== "object" || row.organizationId !== organizationId)
    )
      throw new A2AStateError("Invalid task listing receipt");
    return result as TaskStoreEntry[];
  }
  async import(
    organizationId: string,
    entries: A2ATaskSnapshot[],
    sourceQuiesced: true,
  ): Promise<void> {
    const result = await this.call(organizationId, {
      operation: "import",
      entries,
      sourceQuiesced,
    });
    if (result !== entries.length) throw new A2AStateError("Invalid task import receipt");
  }
}
export function getCloudflareA2ATaskStore(): CloudflareA2ATaskStore | null {
  const backend = getCloudAwareEnv().CLOUD_A2A_STATE_BACKEND ?? "redis";
  if (backend === "redis") return null;
  if (backend !== "cloudflare") throw new A2AStateError("Invalid CLOUD_A2A_STATE_BACKEND");
  const binding = getCloudBinding<RuntimeDurableObjectNamespace>("A2A_TASK_STATE");
  if (!binding) throw new A2AStateError("A2A_TASK_STATE binding is required");
  return new CloudflareA2ATaskStore(binding);
}
