/** Source-only named backup boundary. No production transport is connected. */
export interface BackupBinding {
  projectId: string;
  environmentId: string;
  serviceId: string;
  volumeId: string;
}
export interface BackupItem {
  id: string;
  name: string;
  volumeId: string;
  createdAtMs: number;
  expiresAtMs: number | null;
}
export interface BackupTransport {
  binding(): Promise<BackupBinding>;
  list(volumeId: string): Promise<BackupItem[]>;
  persistIntent(
    operationName: string,
    binding: BackupBinding,
    priorIds: string[],
  ): Promise<void>;
  create(
    volumeId: string,
    operationName: string,
  ): Promise<{ workflowId: string }>;
  /** Poll pinned workflowStatus with bounded timeout; never forward raw error text. */
  status(workflowId: string): Promise<"Complete" | "Error" | "unconfirmed">;
  persistProof(
    workflowId: string,
    backup: BackupItem,
    binding: BackupBinding,
  ): Promise<void>;
}
export async function createPitrSafetyBackup(input: {
  binding: BackupBinding;
  operationName: string;
  expiresAtMs: number;
  transport: BackupTransport;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  let submitted = false;
  const result = (
    state: "refused" | "unconfirmed" | "failed" | "completed_retained",
  ) => ({
    state,
    automaticRetryAllowed: false,
    productionMigrationReady: false,
  });
  try {
    const binding = structuredClone(input.binding);
    const name = input.operationName;
    const expiry = input.expiresAtMs;
    const keys = [
      "projectId",
      "environmentId",
      "serviceId",
      "volumeId",
    ] as const;
    const same = (other: BackupBinding) =>
      keys.every(
        (key) =>
          binding[key as keyof BackupBinding] ===
          other[key as keyof BackupBinding],
      );
    if (
      !/^alpha-pitr-safety-[a-f0-9]{32}$/.test(name) ||
      !Number.isFinite(expiry) ||
      !Number.isFinite(now()) ||
      now() >= expiry ||
      !keys.every(
        (key) => typeof binding[key] === "string" && binding[key].length > 0,
      ) ||
      !same(await input.transport.binding())
    )
      return result("refused");
    const prior = await input.transport.list(binding.volumeId);
    if (prior.some((entry) => entry.name === name)) return result("refused");
    await input.transport.persistIntent(
      name,
      binding,
      prior.map((entry) => entry.id),
    );
    if (now() >= expiry || !same(await input.transport.binding()))
      return result("refused");
    const start = now();
    submitted = true;
    const operation = await input.transport.create(binding.volumeId, name);
    if (!operation.workflowId) return result("unconfirmed");
    const status = await input.transport.status(operation.workflowId);
    if (status === "Error") return result("failed");
    if (status !== "Complete" || !same(await input.transport.binding()))
      return result("unconfirmed");
    const entries = (await input.transport.list(binding.volumeId)).filter(
      (entry) => entry.name === name,
    );
    if (entries.length !== 1) return result("unconfirmed");
    const backup = entries[0];
    const proofTime = now();
    if (
      !Number.isFinite(proofTime) ||
      !backup.id ||
      prior.some((entry) => entry.id === backup.id) ||
      backup.volumeId !== binding.volumeId ||
      !Number.isFinite(backup.createdAtMs) ||
      backup.createdAtMs < start ||
      backup.createdAtMs > proofTime ||
      (backup.expiresAtMs !== null &&
        (!Number.isFinite(backup.expiresAtMs) ||
          backup.expiresAtMs <= expiry ||
          backup.expiresAtMs <= proofTime))
    )
      return result("unconfirmed");
    await input.transport.persistProof(operation.workflowId, backup, binding);
    return result("completed_retained");
  } catch {
    // error-policy:J1 workflow errors may contain private provider metadata.
    return result(submitted ? "unconfirmed" : "refused");
  }
}
