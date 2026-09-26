import { expect, it } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, createCharacter } from "@elizaos/core";
import { secretsManagerPlugin } from "@elizaos/plugin-assistant";
import sqlPlugin from "@elizaos/plugin-sql";
import {
  desktopAcknowledgeRemoteCommandEnqueue,
  desktopCreateRemoteCommand,
  desktopGetOrCreateControllerIdentity,
} from "../src/controller";
import { createRuntimePlatformSecureStore } from "../src/runtime-store";

it("provisions only the missing self world on fresh SQL storage and persists encrypted credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-secret-sql-"));
  const salt = randomBytes(32).toString("hex");
  const runtime = new AgentRuntime({
    character: createCharacter({
      name: `Remote secret regression ${randomUUID()}`,
      settings: { PGLITE_DATA_DIR: directory },
      secrets: { ENCRYPTION_SALT: salt, SECRET_SALT: salt },
    }),
    plugins: [sqlPlugin, secretsManagerPlugin],
  });
  try {
    await runtime.initialize();
    expect(await runtime.getWorld(runtime.agentId)).toBeNull();
    const selfRoom = await runtime.getRoom(runtime.agentId);
    const selfEntity = await runtime.getEntityById(runtime.agentId);
    expect(selfRoom?.worldId).toBe(runtime.agentId);
    const store = createRuntimePlatformSecureStore(runtime);
    const value = JSON.stringify({
      privateKey: randomBytes(32).toString("hex"),
    });
    expect(
      await store.set("controller", "runtime.agent_profiles", value),
    ).toEqual({ ok: true });
    expect(await runtime.getWorld(runtime.agentId)).toMatchObject({
      agentId: runtime.agentId,
    });
    expect(await runtime.getRoom(runtime.agentId)).toEqual(selfRoom);
    const afterEntity = await runtime.getEntityById(runtime.agentId);
    expect(afterEntity?.agentId).toBe(selfEntity?.agentId);
    expect(afterEntity?.names).toEqual(selfEntity?.names);
    expect(afterEntity?.metadata).toEqual(selfEntity?.metadata);
    const components = await runtime.getComponents(runtime.agentId);
    expect(components.length).toBeGreaterThan(0);
    expect(JSON.stringify(components)).not.toContain(
      JSON.parse(value).privateKey,
    );
    expect(JSON.stringify(components)).toContain('"encrypted":true');
    const reopened = createRuntimePlatformSecureStore(runtime);
    // Exercise the capacity boundary through real encrypted SQL persistence.
    const identityRequest = {
      ownerId: runtime.agentId,
      deviceId: randomUUID(),
      displayName: "SQL controller",
      platform: "linux",
    };
    const identity = await desktopGetOrCreateControllerIdentity(
      identityRequest,
      store,
    );
    const targetKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const request = {
      ownerId: runtime.agentId,
      grantId: randomUUID(),
      grantRevision: 1,
      sessionId: randomUUID(),
      controllerDeviceId: identity.deviceId,
      controllerKeyId: identity.keyId,
      targetRuntimeId: randomUUID(),
      targetKeyId: "target-key",
      targetEncryptionPublicKeyJwk: targetKeys.publicKey.export({
        format: "jwk",
      }),
      action: "agent.status",
      payload: {},
    };
    const first = await desktopCreateRemoteCommand(request, store);
    for (let index = 1; index < 256; index++) {
      await desktopCreateRemoteCommand(
        { ...request, sessionId: randomUUID() },
        store,
      );
    }
    const beforeOverflow = JSON.stringify(
      await runtime.getComponents(runtime.agentId),
    );
    await expect(
      desktopCreateRemoteCommand(
        { ...request, sessionId: randomUUID() },
        reopened,
      ),
    ).rejects.toMatchObject({ code: "REMOTE_CONTROLLER_SESSION_CAPACITY" });
    expect(JSON.stringify(await runtime.getComponents(runtime.agentId))).toBe(
      beforeOverflow,
    );
    expect(
      await desktopGetOrCreateControllerIdentity(identityRequest, reopened),
    ).toEqual(identity);
    const recovered = await desktopCreateRemoteCommand(request, reopened);
    expect(recovered.commandId).toBe(first.commandId);
    expect(
      await desktopAcknowledgeRemoteCommandEnqueue(
        {
          ownerId: request.ownerId,
          controllerDeviceId: identity.deviceId,
          sessionId: request.sessionId,
          commandId: first.commandId,
          bindingDigest: first.bindingDigest,
        },
        reopened,
      ),
    ).toEqual({ acknowledged: true });
    const next = await desktopCreateRemoteCommand(request, reopened);
    expect(next.command.body.sequence).toBe(first.command.body.sequence + 1);
    expect(await reopened.get("controller", "runtime.agent_profiles")).toEqual({
      ok: true,
      value,
    });
    expect(
      await reopened.delete("controller", "runtime.agent_profiles"),
    ).toEqual({ ok: true, deleted: true });
    expect(await reopened.get("controller", "runtime.agent_profiles")).toEqual({
      ok: false,
      reason: "not_found",
    });
  } finally {
    await runtime.stop();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
