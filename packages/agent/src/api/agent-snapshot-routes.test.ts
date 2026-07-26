/**
 * Drives schema-v2 snapshot and restore through a real Node HTTP server so
 * route selection, headers, request streaming, and boundary errors are covered
 * together with the filesystem-backed transfer implementation.
 */
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  AGENT_SNAPSHOT_STREAM_CONTENT_TYPE,
  parseCanonicalSnapshotStreamFrame,
} from "../services/agent-snapshot-stream-protocol.ts";
import { handleAgentSnapshotRoutes } from "./agent-snapshot-routes.ts";

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
  PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR,
  POSTGRES_URL: process.env.POSTGRES_URL,
};
const roots = new Set<string>();
const servers = new Set<http.Server>();
const AGENT_ID = "91000000-0000-4000-8000-000000000001";
const POSTGRES_URL =
  "postgres://owner:secret@db.example.com:5432/eliza?schema=tenant";

function runtimeStub(): AgentRuntime {
  return {
    adapter: {},
    agentId: AGENT_ID,
    character: { name: "Route Test Agent" },
    getSetting: (key: string) => (key === "POSTGRES_URL" ? POSTGRES_URL : null),
  } as unknown as AgentRuntime;
}

async function startServer(runtime: AgentRuntime): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (
        await handleAgentSnapshotRoutes({
          config: {} as never,
          method: req.method ?? "GET",
          pathname: url.pathname,
          req,
          res,
          runtime,
          url,
        })
      ) {
        return;
      }
      res.statusCode = 404;
      res.end();
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  roots.add(root);
  return root;
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  servers.clear();
  restoreEnv();
  await Promise.all(
    [...roots].map((root) => fs.rm(root, { force: true, recursive: true })),
  );
  roots.clear();
});

describe.sequential("agent snapshot HTTP routes", () => {
  test("streams exact chunked-v1 NDJSON and restores it through the query contract", async () => {
    const source = await temporaryRoot("eliza-route-source-");
    const target = await temporaryRoot("eliza-route-target-");
    await fs.mkdir(path.join(source, "skills"), { recursive: true });
    await fs.writeFile(path.join(source, "eliza.json"), '{"route":true}\n');
    await fs.writeFile(
      path.join(source, "skills", "route.json"),
      '{"captured":true}\n',
    );
    process.env.ELIZA_STATE_DIR = source;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    const baseUrl = await startServer(runtimeStub());

    const snapshotResponse = await fetch(`${baseUrl}/api/snapshot`, {
      body: JSON.stringify({
        purpose: "pre-upgrade",
        schemaVersion: 2,
        transfer: "chunked-v1",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(snapshotResponse.status).toBe(200);
    expect(snapshotResponse.headers.get("content-type")).toBe(
      AGENT_SNAPSHOT_STREAM_CONTENT_TYPE,
    );
    expect(snapshotResponse.headers.get("cache-control")).toBe("no-store");
    const body = Buffer.from(await snapshotResponse.arrayBuffer());
    const lines = body.subarray(0, -1).toString().split("\n");
    expect(
      parseCanonicalSnapshotStreamFrame(Buffer.from(lines[0] as string)),
    ).toMatchObject({
      format: "elizaos.agent-snapshot-stream",
      schemaVersion: 2,
      transfer: "chunked-v1",
      type: "descriptor",
    });
    const trailer = parseCanonicalSnapshotStreamFrame(
      Buffer.from(lines.at(-1) as string),
    ) as {
      aggregateSha256: string;
      fileCount: number;
      totalBytes: number;
      type: string;
    };
    expect(trailer).toMatchObject({ type: "trailer" });

    process.env.ELIZA_STATE_DIR = target;
    const restoreResponse = await fetch(
      `${baseUrl}/api/restore?transfer=chunked-v1`,
      {
        body,
        headers: { "content-type": AGENT_SNAPSHOT_STREAM_CONTENT_TYPE },
        method: "POST",
      },
    );
    expect(restoreResponse.status).toBe(200);
    await expect(restoreResponse.json()).resolves.toEqual({
      aggregateSha256: trailer.aggregateSha256,
      fileCount: trailer.fileCount,
      requiresRestart: true,
      schemaVersion: 2,
      success: true,
      totalBytes: trailer.totalBytes,
      transfer: "chunked-v1",
    });
    await expect(
      fs.readFile(path.join(target, "skills", "route.json"), "utf8"),
    ).resolves.toBe('{"captured":true}\n');
  });

  test("rejects transfer ambiguity and corrupt input without applying state", async () => {
    const target = await temporaryRoot("eliza-route-invalid-");
    process.env.ELIZA_STATE_DIR = target;
    const baseUrl = await startServer(runtimeStub());
    await fs.writeFile(path.join(target, "sentinel.txt"), "unchanged");

    const ambiguous = await fetch(
      `${baseUrl}/api/restore?transfer=chunked-v1&transfer=chunked-v1`,
      {
        body: "{}\n",
        headers: { "content-type": AGENT_SNAPSHOT_STREAM_CONTENT_TYPE },
        method: "POST",
      },
    );
    expect(ambiguous.status).toBe(400);

    const wrongContentType = await fetch(
      `${baseUrl}/api/restore?transfer=chunked-v1`,
      {
        body: "{}\n",
        headers: { "content-type": "application/x-ndjson" },
        method: "POST",
      },
    );
    expect(wrongContentType.status).toBe(400);

    const truncated = await fetch(
      `${baseUrl}/api/restore?transfer=chunked-v1`,
      {
        body: `${JSON.stringify({
          agentId: AGENT_ID,
          chunkSize: 262144,
          components: {},
          createdAt: new Date().toISOString(),
          files: [],
          format: "elizaos.agent-snapshot-stream",
          schemaVersion: 2,
          transfer: "chunked-v1",
          type: "descriptor",
        })}\n`,
        headers: { "content-type": AGENT_SNAPSHOT_STREAM_CONTENT_TYPE },
        method: "POST",
      },
    );
    expect(truncated.status).toBe(400);
    await expect(
      fs.readFile(path.join(target, "sentinel.txt"), "utf8"),
    ).resolves.toBe("unchanged");
    await expect(fs.readdir(target)).resolves.toEqual(["sentinel.txt"]);
  });
});
