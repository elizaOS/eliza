/** Agent-scoped encrypted component storage through the existing SecretsService. */
import { createHash } from "node:crypto";
import {
  ChannelType,
  ElizaError,
  type IAgentRuntime,
  type Service,
} from "@elizaos/core";
import type {
  PlatformSecureStore,
  SecureStoreSecretKind,
} from "./secure-store-contract";

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
  async function ensureContext(): Promise<void> {
    // ComponentSecretStorage uses the runtime's canonical self room/world.
    // Initialization creates the self entity and room, but may lack the world.
    const entity = await runtime.getEntityById(runtime.agentId);
    const room = await runtime.getRoom(runtime.agentId);
    if (
      entity?.agentId !== runtime.agentId ||
      room?.agentId !== runtime.agentId ||
      room.worldId !== runtime.agentId ||
      room.type !== ChannelType.SELF
    )
      throw new ElizaError(
        "Runtime secret storage requires its initialized self context.",
        {
          code: "REMOTE_SECRET_CONTEXT_DENIED",
        },
      );
    let world = await runtime.getWorld(runtime.agentId);
    if (!world) {
      try {
        // Insert only: an upsert must never reassign another agent's world.
        await runtime.createWorld({
          id: runtime.agentId,
          agentId: runtime.agentId,
        });
      } catch (error) {
        if (
          !(error instanceof ElizaError) ||
          error.code !== "WORLD_ALREADY_EXISTS"
        )
          throw error;
        // error-policy:J2 a concurrent creator won; validate its ownership below.
      }
      world = await runtime.getWorld(runtime.agentId);
    }
    if (world?.agentId !== runtime.agentId)
      throw new ElizaError("Runtime secret world belongs to another context.", {
        code: "REMOTE_SECRET_CONTEXT_DENIED",
      });
  }
  function service(): RuntimeSecrets {
    const secrets = runtime.getService<RuntimeSecrets>("SECRETS");
    if (
      !secrets ||
      typeof secrets.get !== "function" ||
      typeof secrets.set !== "function" ||
      typeof secrets.delete !== "function"
    )
      throw new ElizaError("Encrypted runtime SecretsService is unavailable.", {
        code: "REMOTE_SECRET_STORE_UNAVAILABLE",
      });
    return secrets;
  }
  function key(vaultId: string, kind: SecureStoreSecretKind): string {
    if (kind !== "runtime.agent_profiles" || !vaultId || vaultId.length > 256)
      throw new ElizaError("Unauthorized remote-controller secret slot.", {
        code: "REMOTE_SECRET_STORE_DENIED",
      });
    return `REMOTE_BROWSER_${createHash("sha256").update(`${runtime.agentId}\0${vaultId}\0${kind}`).digest("hex")}`;
  }
  return {
    backend: "runtime_encrypted_store",
    async isAvailable() {
      return Boolean(runtime.getService("SECRETS"));
    },
    async get(vaultId, kind) {
      const secrets = service();
      const slot = key(vaultId, kind);
      await ensureContext();
      const value = await secrets.get(slot, context);
      return value === null
        ? { ok: false, reason: "not_found" }
        : { ok: true, value };
    },
    async set(vaultId, kind, value) {
      const secrets = service();
      const slot = key(vaultId, kind);
      await ensureContext();
      const ok = await secrets.set(slot, value, context, {
        encrypted: true,
        plugin: "remote-browser-controller",
      });
      return ok ? { ok: true } : { ok: false, reason: "error" };
    },
    async delete(vaultId, kind) {
      const secrets = service();
      const slot = key(vaultId, kind);
      await ensureContext();
      return {
        ok: true,
        deleted: await secrets.delete(slot, context),
      };
    },
  };
}
