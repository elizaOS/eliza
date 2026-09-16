/** Restart-safe setup and removal coordinator for verified SSH runtimes. */
import type { AgentProfile, AgentProfileRegistry } from "../state";
import { shellLocalStorage } from "../surface-realm-channel";
import type { SshRuntimeEnrollment } from "./ssh-runtime";

const RECEIPTS_STORAGE_KEY = "eliza.remote.ssh-lifecycle-receipts.v2";

type CleanupStep =
  | "tunnel-stop"
  | "credential-delete"
  | "profile-remove"
  | "receipt-persist";

interface PendingCleanupSteps {
  stopTunnel: boolean;
  deleteCredential: boolean;
  removeProfile: boolean;
}

export interface SshRuntimeLifecycleReceipt {
  version: 2;
  operationId: string;
  state: "setup" | "removal" | "committed";
  runtimeId: string;
  profileId: string;
  createdAt: string;
  pending: PendingCleanupSteps;
}

export interface SshRuntimeCleanupFailure {
  step: CleanupStep;
  message: string;
}

export interface SshRuntimeCleanupResult {
  complete: boolean;
  receipt: SshRuntimeLifecycleReceipt;
  failures: SshRuntimeCleanupFailure[];
}

export interface SshRuntimeLifecycleReceiptStore {
  list(): SshRuntimeLifecycleReceipt[];
  put(receipt: SshRuntimeLifecycleReceipt): void;
  delete(operationId: string): void;
}

export interface SshRuntimeLifecycleDependencies {
  startTunnel(input: SshRuntimeEnrollment): Promise<unknown>;
  stopTunnel(runtimeId: string): Promise<unknown>;
  storeCredential(runtimeId: string, value: string): Promise<unknown>;
  deleteCredentialRecord(runtimeId: string): Promise<unknown>;
  addProfile(
    profile: Omit<AgentProfile, "id" | "createdAt">,
    options: { activate: false; id: string },
  ): AgentProfile;
  removeProfile(profileId: string): void;
  loadRegistry(): AgentProfileRegistry;
}

export interface SetupSshRuntimeInput extends SshRuntimeEnrollment {
  label: string;
  accessToken?: string;
}

export class SshRuntimeLifecycleError extends Error {
  readonly code = "SSH_RUNTIME_LIFECYCLE_INCOMPLETE";

  constructor(
    message: string,
    readonly pendingSteps: CleanupStep[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SshRuntimeLifecycleError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Saved SSH cleanup receipt has an invalid ${field}.`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Saved SSH cleanup receipt has an invalid ${field}.`);
  }
  return value;
}

function decodeReceipt(value: unknown): SshRuntimeLifecycleReceipt {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !isRecord(value.pending) ||
    (value.state !== "setup" &&
      value.state !== "removal" &&
      value.state !== "committed")
  ) {
    throw new Error("Saved SSH cleanup receipt has an unsupported format.");
  }
  return {
    version: 2,
    operationId: requireString(value.operationId, "operation id"),
    state: value.state,
    runtimeId: requireString(value.runtimeId, "runtime id"),
    profileId: requireString(value.profileId, "profile id"),
    createdAt: requireString(value.createdAt, "creation time"),
    pending: {
      stopTunnel: requireBoolean(value.pending.stopTunnel, "tunnel state"),
      deleteCredential: requireBoolean(
        value.pending.deleteCredential,
        "credential state",
      ),
      removeProfile: requireBoolean(
        value.pending.removeProfile,
        "profile state",
      ),
    },
  };
}

function readPersistedReceipts(): SshRuntimeLifecycleReceipt[] {
  const raw = globalThis.localStorage?.getItem(RECEIPTS_STORAGE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // error-policy:J2 retain the parser cause while identifying the corrupt store.
    throw new Error("Saved SSH cleanup receipts are not valid JSON.", {
      cause,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Saved SSH cleanup receipts must be an array.");
  }
  return parsed.map(decodeReceipt);
}

export const browserSshRuntimeLifecycleReceiptStore: SshRuntimeLifecycleReceiptStore =
  {
    list: readPersistedReceipts,
    put(receipt) {
      const receipts = readPersistedReceipts();
      const index = receipts.findIndex(
        (candidate) => candidate.operationId === receipt.operationId,
      );
      if (index === -1) receipts.push(receipt);
      else receipts[index] = receipt;
      shellLocalStorage.setItem(RECEIPTS_STORAGE_KEY, JSON.stringify(receipts));
    },
    delete(operationId) {
      const receipts = readPersistedReceipts().filter(
        (candidate) => candidate.operationId !== operationId,
      );
      if (receipts.length === 0) {
        shellLocalStorage.removeItem(RECEIPTS_STORAGE_KEY);
      } else {
        shellLocalStorage.setItem(
          RECEIPTS_STORAGE_KEY,
          JSON.stringify(receipts),
        );
      }
    },
  };

function messageFor(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : String(cause);
}

function pendingStepNames(receipt: SshRuntimeLifecycleReceipt): CleanupStep[] {
  const names: CleanupStep[] = [];
  if (receipt.pending.stopTunnel) names.push("tunnel-stop");
  if (receipt.pending.deleteCredential) names.push("credential-delete");
  if (receipt.pending.removeProfile) names.push("profile-remove");
  return names;
}

async function cleanupReceipt(
  receipt: SshRuntimeLifecycleReceipt,
  dependencies: SshRuntimeLifecycleDependencies,
  store: SshRuntimeLifecycleReceiptStore,
): Promise<SshRuntimeCleanupResult> {
  const failures: SshRuntimeCleanupFailure[] = [];
  if (receipt.state === "committed") {
    try {
      store.delete(receipt.operationId);
      return { complete: true, receipt, failures };
    } catch (cause) {
      // error-policy:J1 lifecycle cleanup returns this explicit failed step.
      failures.push({ step: "receipt-persist", message: messageFor(cause) });
      return { complete: false, receipt, failures };
    }
  }

  const runStep = async (
    step: CleanupStep,
    pending: keyof PendingCleanupSteps,
    operation: () => undefined | Promise<unknown>,
  ) => {
    if (!receipt.pending[pending]) return;
    try {
      await operation();
      receipt.pending[pending] = false;
      store.put(receipt);
    } catch (cause) {
      // error-policy:J1 lifecycle cleanup returns this explicit failed step.
      failures.push({ step, message: messageFor(cause) });
    }
  };

  await runStep("tunnel-stop", "stopTunnel", () =>
    dependencies.stopTunnel(receipt.runtimeId),
  );
  await runStep("credential-delete", "deleteCredential", () =>
    dependencies.deleteCredentialRecord(receipt.runtimeId),
  );
  await runStep("profile-remove", "removeProfile", () => {
    const registry = dependencies.loadRegistry();
    const profile = registry.profiles.find(
      (candidate) => candidate.id === receipt.profileId,
    );
    if (!profile) return;
    if (registry.activeProfileId === profile.id) {
      throw new Error("Switch away from the SSH runtime before removing it.");
    }
    dependencies.removeProfile(profile.id);
    if (
      dependencies
        .loadRegistry()
        .profiles.some((candidate) => candidate.id === profile.id)
    ) {
      throw new Error("The SSH runtime profile could not be removed.");
    }
  });

  const pending = pendingStepNames(receipt);
  if (pending.length === 0) {
    try {
      store.delete(receipt.operationId);
    } catch (cause) {
      // error-policy:J1 lifecycle cleanup returns this explicit failed step.
      failures.push({ step: "receipt-persist", message: messageFor(cause) });
    }
  } else {
    try {
      store.put(receipt);
    } catch (cause) {
      // error-policy:J1 lifecycle cleanup returns this explicit failed step.
      failures.push({ step: "receipt-persist", message: messageFor(cause) });
    }
  }
  return {
    complete:
      pending.length === 0 &&
      !failures.some((failure) => failure.step === "receipt-persist"),
    receipt,
    failures,
  };
}

let lifecycleTail: Promise<void> = Promise.resolve();

function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const started = lifecycleTail.then(operation, operation);
  lifecycleTail = started.then(
    () => undefined,
    // error-policy:J5 the caller observes the same rejection from `started`.
    () => undefined,
  );
  return started;
}

export function resumePendingSshRuntimeCleanups(
  dependencies: SshRuntimeLifecycleDependencies,
  store: SshRuntimeLifecycleReceiptStore = browserSshRuntimeLifecycleReceiptStore,
): Promise<SshRuntimeCleanupResult[]> {
  return serializeLifecycle(async () => {
    const results: SshRuntimeCleanupResult[] = [];
    for (const receipt of store.list()) {
      results.push(await cleanupReceipt(receipt, dependencies, store));
    }
    return results;
  });
}

export function setupSshRuntime(
  input: SetupSshRuntimeInput,
  dependencies: SshRuntimeLifecycleDependencies,
  store: SshRuntimeLifecycleReceiptStore = browserSshRuntimeLifecycleReceiptStore,
): Promise<AgentProfile> {
  return serializeLifecycle(async () => {
    const unfinished = store
      .list()
      .filter((receipt) => receipt.state !== "committed");
    if (unfinished.length > 0) {
      throw new SshRuntimeLifecycleError(
        "Finish the previous SSH cleanup before adding another server.",
        unfinished.flatMap(pendingStepNames),
      );
    }
    const receipt: SshRuntimeLifecycleReceipt = {
      version: 2,
      operationId: crypto.randomUUID(),
      state: "setup",
      runtimeId: input.runtimeId,
      profileId: input.runtimeId,
      createdAt: new Date().toISOString(),
      pending: {
        stopTunnel: true,
        // desktopStartSshRuntime persists the verified fingerprint before
        // spawning SSH, so failure cleanup must remove the entire record even
        // when no bearer token was supplied.
        deleteCredential: true,
        removeProfile: true,
      },
    };
    // Fail closed before the first credential, fingerprint, or process write.
    store.put(receipt);
    let profile: AgentProfile | null = null;
    try {
      if (input.accessToken) {
        await dependencies.storeCredential(input.runtimeId, input.accessToken);
      }
      await dependencies.startTunnel(input);
      profile = dependencies.addProfile(
        {
          kind: "remote",
          label: input.label,
          apiBase: `eliza-ssh://runtime/${input.runtimeId}`,
          credentialRef: input.runtimeId,
          connectionMode: "ssh",
          ssh: {
            target: input.target,
            sshPort: input.sshPort,
            remoteApiPort: input.remoteApiPort,
            hostFingerprint: input.expectedFingerprint,
            ...(input.identityFile ? { identityFile: input.identityFile } : {}),
          },
        },
        { activate: false, id: input.runtimeId },
      );
      receipt.state = "committed";
      store.put(receipt);
    } catch (cause) {
      // error-policy:J2 rollback failures are attached to the typed setup error.
      const cleanup = await cleanupReceipt(receipt, dependencies, store);
      const pending = pendingStepNames(cleanup.receipt);
      throw new SshRuntimeLifecycleError(
        cleanup.complete
          ? `${messageFor(cause)} No partial SSH connection was kept.`
          : `${messageFor(cause)} SSH cleanup is incomplete; retry before adding another server.`,
        pending,
        { cause },
      );
    }
    try {
      store.delete(receipt.operationId);
    } catch {
      // error-policy:J6 the durable committed marker is safe restart cleanup.
      // The committed marker is intentionally retained: restart recovery prunes
      // it without tearing down a successfully configured runtime.
    }
    if (!profile)
      throw new Error("SSH runtime setup completed without a profile.");
    return profile;
  });
}

export function removeSshRuntime(
  profile: AgentProfile,
  dependencies: SshRuntimeLifecycleDependencies,
  store: SshRuntimeLifecycleReceiptStore = browserSshRuntimeLifecycleReceiptStore,
): Promise<void> {
  return serializeLifecycle(async () => {
    if (profile.connectionMode !== "ssh" || !profile.ssh) return;
    const registry = dependencies.loadRegistry();
    if (registry.activeProfileId === profile.id) {
      throw new Error("Switch away from the SSH runtime before removing it.");
    }
    const existing = store
      .list()
      .find((receipt) => receipt.profileId === profile.id);
    const receipt: SshRuntimeLifecycleReceipt = existing ?? {
      version: 2,
      operationId: crypto.randomUUID(),
      state: "removal",
      runtimeId: profile.id,
      profileId: profile.id,
      createdAt: new Date().toISOString(),
      pending: {
        stopTunnel: true,
        deleteCredential: true,
        removeProfile: true,
      },
    };
    store.put(receipt);
    const cleanup = await cleanupReceipt(receipt, dependencies, store);
    if (!cleanup.complete) {
      throw new SshRuntimeLifecycleError(
        "SSH cleanup is incomplete; retry the remaining steps.",
        pendingStepNames(cleanup.receipt),
      );
    }
  });
}

export function retrySshRuntimeCleanup(
  profileId: string,
  dependencies: SshRuntimeLifecycleDependencies,
  store: SshRuntimeLifecycleReceiptStore = browserSshRuntimeLifecycleReceiptStore,
): Promise<boolean> {
  return serializeLifecycle(async () => {
    const receipt = store
      .list()
      .find((candidate) => candidate.profileId === profileId);
    if (!receipt) return false;
    const cleanup = await cleanupReceipt(receipt, dependencies, store);
    if (!cleanup.complete) {
      throw new SshRuntimeLifecycleError(
        "SSH cleanup is incomplete; retry the remaining steps.",
        pendingStepNames(cleanup.receipt),
      );
    }
    return true;
  });
}

export const sshRuntimeLifecycleInternals = {
  RECEIPTS_STORAGE_KEY,
  decodeReceipt,
  pendingStepNames,
};
