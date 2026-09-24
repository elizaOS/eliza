/** Agent-scoped encrypted component storage through the existing SecretsService. */
import { createHash } from "node:crypto";
import type { IAgentRuntime, Service } from "@elizaos/core";
import type {
  PlatformSecureStore,
  SecureStoreSecretKind,
} from "./platform-secure-store";

type Context = {
  level: "user";
  agentId: string;
  userId: string;
  requesterId: string;
};
type RuntimeSecrets = Service & {
  get(key: string, context: Context): Promise<string | null>;
  set(
    key: string,
    value: string,
    context: Context,
    config: { encrypted: true; plugin: string },
  ): Promise<boolean>;
  delete(key: string, context: Context): Promise<boolean>;
};

export function createRuntimePlatformSecureStore(
  runtime: IAgentRuntime,
): PlatformSecureStore {
  const context: Context = {
    level: "user",
    agentId: runtime.agentId,
    userId: runtime.agentId,
    requesterId: runtime.agentId,
  };
  function service(): RuntimeSecrets {
    const secrets = runtime.getService<RuntimeSecrets>("SECRETS");
    if (
      !secrets ||
      typeof secrets.get !== "function" ||
      typeof secrets.set !== "function" ||
      typeof secrets.delete !== "function"
    )
      throw new Error("Encrypted runtime SecretsService is unavailable.");
    return secrets;
  }
  function key(vaultId: string, kind: SecureStoreSecretKind): string {
    if (kind !== "runtime.agent_profiles" || !vaultId || vaultId.length > 256)
      throw new Error("Unauthorized remote-controller secret slot.");
    return `REMOTE_BROWSER_${createHash("sha256").update(`${runtime.agentId}\0${vaultId}\0${kind}`).digest("hex")}`;
  }
  return {
    backend: "runtime_encrypted_store",
    async isAvailable() {
      return runtime.getService("SECRETS") !== null;
    },
    async get(vaultId, kind) {
      const value = await service().get(key(vaultId, kind), context);
      return value === null
        ? { ok: false, reason: "not_found" }
        : { ok: true, value };
    },
    async set(vaultId, kind, value) {
      const ok = await service().set(key(vaultId, kind), value, context, {
        encrypted: true,
        plugin: "remote-browser-controller",
      });
      return ok ? { ok: true } : { ok: false, reason: "error" };
    },
    async delete(vaultId, kind) {
      return {
        ok: true,
        deleted: await service().delete(key(vaultId, kind), context),
      };
    },
  };
}
