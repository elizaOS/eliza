/**
 * Exercises the real HTTP transport used to stream large agent backup JSON
 * without substituting a response mock for Node's buffering behavior.
 */

import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBackupStateData } from "../services/agent-backup.ts";
import { writeAgentBackupJsonResponse } from "./backup-json-response.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function serveSnapshot(
  snapshot: AgentBackupStateData,
): Promise<Response> {
  const server = http.createServer((_req, res) => {
    void writeAgentBackupJsonResponse(res, snapshot);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return fetch(`http://127.0.0.1:${address.port}`);
}

function snapshotWithConfig(
  config: Record<string, unknown>,
): AgentBackupStateData {
  return {
    memories: [],
    config,
    workspaceFiles: {},
    manifest: {
      schemaVersion: 1,
      format: "elizaos.agent-backup",
      createdAt: "2026-08-13T00:00:00.000Z",
      agentId: "00000000-0000-4000-8000-000000000000",
      components: {
        database: { kind: "none", reason: "test", sha256: "db" },
        media: {
          kind: "file-set",
          rootLabel: "state-dir",
          files: [],
          sha256: "media",
        },
        vault: {
          kind: "file-set",
          rootLabel: "state-dir",
          files: [],
          sha256: "vault",
        },
        character: { runtimeCharacter: {}, sha256: "character" },
        stateFiles: {
          kind: "file-set",
          rootLabel: "state-dir",
          files: [],
          sha256: "state",
        },
      },
      integrity: { componentHashes: {} },
    },
  };
}

describe("writeAgentBackupJsonResponse", () => {
  it("round-trips a multi-chunk backup response through a real HTTP server", async () => {
    const largeValue = "backup-data-".repeat(300_000);
    const snapshot = snapshotWithConfig({ largeValue });

    const response = await serveSnapshot(snapshot);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual(snapshot);
  });

  it("preserves escaping, surrogate pairs, arrays, and JSON omission rules", async () => {
    const boundaryPrefix = "x".repeat(256 * 1024 - 1);
    const snapshot = snapshotWithConfig({
      text: `${boundaryPrefix}😀\n"done`,
      array: [undefined, Number.NaN, true],
      omitted: undefined,
      date: new Date("2026-08-13T00:00:00.000Z"),
    });

    const response = await serveSnapshot(snapshot);
    const parsed = (await response.json()) as AgentBackupStateData;

    expect(parsed.config).toEqual({
      text: `${boundaryPrefix}😀\n"done`,
      array: [null, null, true],
      date: "2026-08-13T00:00:00.000Z",
    });
  });
});
