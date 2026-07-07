/**
 * Real route-level contract for role-aware artifact disclosure (#14781),
 * exercised over a real TCP socket through the ACTUAL server dispatch chain:
 * the 401 boundary gate (`isAuthorized || isBoundaryRoleAuthorized`), the
 * registered share-viewer TokenRoleResolver, `resolveHttpAccessContext`, the
 * Hono mount → `dispatchRoute` → `filesListRoute.routeHandler`, and the
 * `selectFilesForViewer` use-case — none of it mocked. Files bytes come from
 * the REAL `LocalFileStorageService` over a temp media store.
 *
 * The harness reproduces server.ts's gate + dispatch wiring verbatim EXCEPT it
 * uses token-only trunk auth (no loopback-trust): `isAuthorized` short-circuits
 * to OWNER for any loopback socket, which would collapse every role to OWNER, so
 * a faithful multi-role test must model the production non-loopback boundary
 * where a bearer token or a resolver principal is the only authority. That is
 * the one deliberate substitution; every layer that decides disclosure is real.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { type IAgentRuntime, ServiceType, type UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueArtifactShareViewerToken } from "../../src/api/artifact-share-role-resolver.ts";
import { filesRoutes } from "../../src/api/files-routes.ts";
import { tryHandleHonoRuntimeRoute } from "../../src/api/hono-mount.ts";
import { resolveHttpAccessContext } from "../../src/api/http-access-context.ts";
import { isBoundaryRoleAuthorized } from "../../src/api/server-helpers-auth.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
const API_TOKEN = "owner-trunk-token";
const SHARE_SECRET = "real-server-share-secret";

let stateDir: string;
let server: http.Server;
let baseUrl: string;

/** Token-only trunk auth (mirrors a non-loopback deployment boundary). */
function trunkAuthorized(req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization ?? "";
  return auth === `Bearer ${API_TOKEN}`;
}

beforeAll(async () => {
  stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "artifact-disclosure-real-"),
  );
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_ARTIFACT_SHARE_TOKEN_SECRET = SHARE_SECRET;

  // Real content-addressed file storage over the temp state dir.
  const { LocalFileStorageService } = await import(
    "../../src/services/file-storage.ts"
  );
  const runtimeForStorage = { agentId: AGENT_ID } as unknown as IAgentRuntime;
  const storage = await LocalFileStorageService.start(runtimeForStorage);
  await storage.store(Buffer.from("hello world pdf"), "application/pdf");
  await storage.store(Buffer.from("an image"), "image/png");

  const runtime = {
    agentId: AGENT_ID,
    routes: filesRoutes,
    getService: (type: string) =>
      type === ServiceType.REMOTE_FILES ? storage : null,
  } as unknown as IAgentRuntime;

  // The server dispatch wiring, reproduced from api/server.ts.
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const pathname = url.pathname;

    if (
      !trunkAuthorized(req) &&
      !isBoundaryRoleAuthorized(req, method, pathname)
    ) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const handled = await tryHandleHonoRuntimeRoute({
      req,
      res,
      runtime,
      isAuthorized: () =>
        trunkAuthorized(req) || isBoundaryRoleAuthorized(req, method, pathname),
      isTrustedLocal: () => false,
      accessContext: () =>
        trunkAuthorized(req) ? undefined : resolveHttpAccessContext(req),
    });
    if (!handled) {
      res.statusCode = 404;
      res.end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(stateDir, { recursive: true, force: true });
  delete process.env.ELIZA_ARTIFACT_SHARE_TOKEN_SECRET;
});

async function getFiles(authHeader?: string): Promise<{
  status: number;
  body: { files?: unknown[]; restricted?: boolean; error?: string };
}> {
  const res = await fetch(`${baseUrl}/api/files`, {
    headers: authHeader ? { authorization: authHeader } : {},
  });
  const body = (await res.json().catch(() => ({}))) as {
    files?: unknown[];
    restricted?: boolean;
    error?: string;
  };
  return { status: res.status, body };
}

describe("GET /api/files role-aware disclosure (real server)", () => {
  it("refuses an unauthenticated caller with 401", async () => {
    const { status, body } = await getFiles();
    expect(status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("OWNER (trunk token) sees the full store", async () => {
    const { status, body } = await getFiles(`Bearer ${API_TOKEN}`);
    expect(status).toBe(200);
    expect(body.restricted).toBe(false);
    expect(body.files).toHaveLength(2);
  });

  it("USER share-viewer sees the designed restricted state, not the store", async () => {
    const token = issueArtifactShareViewerToken({
      entityId: VIEWER,
      role: "USER",
      ttlMs: 60_000,
    });
    const { status, body } = await getFiles(`Bearer ${token}`);
    expect(status).toBe(200);
    expect(body.restricted).toBe(true);
    expect(body.files).toEqual([]);
  });

  it("GUEST share-viewer is likewise restricted", async () => {
    const token = issueArtifactShareViewerToken({
      entityId: VIEWER,
      role: "GUEST",
      ttlMs: 60_000,
    });
    const { status, body } = await getFiles(`Bearer ${token}`);
    expect(status).toBe(200);
    expect(body.restricted).toBe(true);
    expect(body.files).toEqual([]);
  });

  it("a share-viewer token cannot reach a mutating route (allowlist is GET-only)", async () => {
    const token = issueArtifactShareViewerToken({
      entityId: VIEWER,
      role: "USER",
      ttlMs: 60_000,
    });
    const res = await fetch(`${baseUrl}/api/files/anything.png`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    // The boundary gate refuses: DELETE is outside the viewer route allowlist.
    expect(res.status).toBe(401);
  });

  it("an expired share-viewer token is refused at the boundary", async () => {
    const token = issueArtifactShareViewerToken(
      { entityId: VIEWER, role: "USER", ttlMs: 1 },
      0,
    );
    const { status } = await getFiles(`Bearer ${token}`);
    expect(status).toBe(401);
  });
});
