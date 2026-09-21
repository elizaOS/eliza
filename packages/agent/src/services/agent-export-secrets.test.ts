/**
 * Proves the encrypted agent-transfer boundary excludes both supported secret
 * containers on export and import. The harness drives the real crypto and
 * serialization path with deterministic in-memory adapter fixtures.
 */
import * as crypto from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  AGENT_EXPORT_INVALID_SETTINGS,
  AgentExportError,
  type AgentExportPayload,
  exportAgent,
  importAgent,
} from "./agent-export.ts";

const PASSWORD = "password12ok";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const MAGIC = Buffer.from("ELIZA_AGENT_V1\n", "utf-8");
const LIVE_KEY = "sk-live-must-not-leave-the-machine";
const ROOT_SECRET = "root-secret-must-not-leave-the-machine";

function emptyPayload(agent: Record<string, unknown>): AgentExportPayload {
  return {
    version: 2,
    exportedAt: "2026-09-25T00:00:00.000Z",
    sourceAgentId: AGENT_ID,
    agent,
    entities: [],
    memories: [],
    components: [],
    rooms: [],
    participants: [],
    relationships: [],
    worlds: [],
    tasks: [],
    logs: [],
  } as AgentExportPayload;
}

function decryptBundle(fileBuffer: Buffer): string {
  let offset = MAGIC.length;
  const iterations = fileBuffer.readUInt32BE(offset);
  offset += 4;
  const salt = fileBuffer.subarray(offset, offset + 32);
  offset += 32;
  const iv = fileBuffer.subarray(offset, offset + 12);
  offset += 12;
  const tag = fileBuffer.subarray(offset, offset + 16);
  offset += 16;
  const key = crypto.pbkdf2Sync(PASSWORD, salt, iterations, 32, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  decipher.setAuthTag(tag);
  return gunzipSync(
    Buffer.concat([
      decipher.update(fileBuffer.subarray(offset)),
      decipher.final(),
    ]),
  ).toString("utf-8");
}

async function encryptPayload(payload: AgentExportPayload): Promise<Buffer> {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const key = await new Promise<Buffer>((resolve, reject) => {
    crypto.pbkdf2(PASSWORD, salt, 1, 32, "sha256", (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload), "utf-8"));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const iterations = Buffer.alloc(4);
  iterations.writeUInt32BE(1, 0);
  return Buffer.concat([
    MAGIC,
    iterations,
    salt,
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

function exportRuntime(): AgentRuntime {
  const storedAgent = {
    id: AGENT_ID,
    name: "Ada",
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    secrets: { ROOT_TOKEN: ROOT_SECRET },
    settings: {
      defaultTemperature: 0.2,
      secrets: { OPENAI_API_KEY: LIVE_KEY },
    },
  };
  return {
    agentId: AGENT_ID,
    character: {
      name: "Ada",
      topics: ["backups"],
      secrets: { ROOT_TOKEN: ROOT_SECRET },
      settings: {
        defaultTemperature: 0.2,
        secrets: { OPENAI_API_KEY: LIVE_KEY },
      },
    },
    adapter: {
      getAgentsByIds: async () => [storedAgent],
      getAllWorlds: async () => [],
      getRoomsForParticipants: async () => [],
      getRelationships: async () => [],
      getTasks: async () => [],
      listMemoryTypes: async () => [],
    },
  } as unknown as AgentRuntime;
}

function importRuntime(): {
  createdAgents: Array<Record<string, unknown>>;
  runtime: AgentRuntime;
} {
  const createdAgents: Array<Record<string, unknown>> = [];
  const scopedAdapter = {
    createAgents: async (rows: Array<Record<string, unknown>>) => {
      createdAgents.push(...rows);
      return rows.map((row) => row.id as string);
    },
  };
  const adapter = {
    withAgentScope: async (
      _agentId: string,
      callback: (scoped: typeof scopedAdapter) => Promise<unknown>,
    ) => callback(scopedAdapter),
  };
  return {
    createdAgents,
    runtime: { agentId: AGENT_ID, adapter } as unknown as AgentRuntime,
  };
}

describe("agent export secret boundary", () => {
  it("omits root and settings secrets from encrypted exports", async () => {
    const fileBuffer = await exportAgent(exportRuntime(), PASSWORD);
    const json = decryptBundle(fileBuffer);
    const payload = JSON.parse(json) as AgentExportPayload;

    expect(json).not.toContain(LIVE_KEY);
    expect(json).not.toContain(ROOT_SECRET);
    expect((payload.agent as { secrets?: unknown }).secrets).toBeUndefined();
    expect(payload.agent.settings).toEqual({ defaultTemperature: 0.2 });
    expect(
      (payload.characterConfig as { secrets?: unknown }).secrets,
    ).toBeUndefined();
    expect(payload.characterConfig?.settings).toEqual({
      defaultTemperature: 0.2,
    });
  });

  it("does not plant root or settings secrets from an imported bundle", async () => {
    const { createdAgents, runtime } = importRuntime();
    const fileBuffer = await encryptPayload(
      emptyPayload({
        name: "Mallory",
        secrets: { ROOT_TOKEN: ROOT_SECRET },
        settings: {
          defaultTemperature: 0.7,
          secrets: { OPENAI_API_KEY: LIVE_KEY },
        },
      }),
    );

    await expect(
      importAgent(runtime, fileBuffer, PASSWORD),
    ).resolves.toMatchObject({ success: true });
    expect(createdAgents).toHaveLength(1);
    expect(createdAgents[0]?.secrets).toBeUndefined();
    expect(createdAgents[0]?.settings).toEqual({ defaultTemperature: 0.7 });
    expect(JSON.stringify(createdAgents)).not.toContain(LIVE_KEY);
    expect(JSON.stringify(createdAgents)).not.toContain(ROOT_SECRET);
  });

  it("rejects non-object settings before creating an agent", async () => {
    const { createdAgents, runtime } = importRuntime();
    const fileBuffer = await encryptPayload(
      emptyPayload({ name: "Mallory", settings: null }),
    );

    const failure = await importAgent(runtime, fileBuffer, PASSWORD).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AgentExportError);
    expect((failure as AgentExportError).code).toBe(
      AGENT_EXPORT_INVALID_SETTINGS,
    );
    expect(createdAgents).toHaveLength(0);
  });
});
