/**
 * Mints the trusted local desktop browser session after proving possession of
 * a one-shot Unix socket created by the Electrobun main process. The route is
 * loopback-only, originless, and restricted to owner-only socket paths so a
 * web page cannot turn localhost reachability into a desktop session.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { logger, resolveStateDir } from "@elizaos/core";
import { AuthStore, type DrizzleDatabase } from "../services/auth-store";
import {
  appendAuditEvent,
  createBrowserSession,
  DESKTOP_LOOPBACK_SESSION_SCOPE,
} from "./auth/index";
import {
  type CompatRuntimeState,
  isTrustedLocalRequest,
  readCompatJsonBody,
} from "./compat-route-shared";
import { sendJson, sendJsonError } from "./response";

const DESKTOP_BOOTSTRAP_PATH = "/api/auth/desktop-bootstrap";
const SOCKET_SECRET_BYTES = 32;
const SOCKET_TIMEOUT_MS = 5_000;

interface AdapterWithDb {
  db?: unknown;
}

function getDrizzleDb(state: CompatRuntimeState): DrizzleDatabase | null {
  const adapter = state.current?.adapter as AdapterWithDb | undefined;
  return adapter?.db ? (adapter.db as DrizzleDatabase) : null;
}

function resolveAllowedSocketRoots(): string[] {
  return [path.join(resolveStateDir(), "sockets"), os.tmpdir()].map((root) =>
    path.resolve(root),
  );
}

function isAllowedSocketPath(socketPath: string): boolean {
  if (!path.isAbsolute(socketPath)) return false;
  const resolved = path.resolve(socketPath);
  const basename = path.basename(resolved);
  const allowedName =
    /^desktop-auth-[a-f0-9]{16}\.sock$/.test(basename) ||
    /^mda-[a-f0-9]{8}\.sock$/.test(basename);
  if (!allowedName) return false;
  return resolveAllowedSocketRoots().some((root) =>
    resolved.startsWith(`${root}${path.sep}`),
  );
}

export async function consumeDesktopSocketProof(
  socketPath: string,
): Promise<boolean> {
  if (!isAllowedSocketPath(socketPath)) return false;

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch {
    // error-policy:J3 an absent/unreadable socket is invalid proof.
    return false;
  }
  if (!stat.isSocket() || (stat.mode & 0o077) !== 0) return false;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(valid);
    };
    const timeout = setTimeout(() => finish(false), SOCKET_TIMEOUT_MS);
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      if (chunks.reduce((sum, value) => sum + value.length, 0) > 64) {
        finish(false);
      }
    });
    socket.once("end", () => {
      finish(Buffer.concat(chunks).length === SOCKET_SECRET_BYTES);
    });
    socket.once("error", () => finish(false));
  });
}

export async function handleDesktopAuthBootstrapRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (method !== "POST" || url.pathname !== DESKTOP_BOOTSTRAP_PATH) {
    return false;
  }

  if (
    !isTrustedLocalRequest(req) ||
    req.headers.origin !== undefined ||
    req.headers.referer !== undefined
  ) {
    sendJsonError(res, 403, "desktop_bootstrap_forbidden");
    return true;
  }

  const db = getDrizzleDb(state);
  if (!db) {
    sendJsonError(res, 503, "db_unavailable");
    return true;
  }

  const body = await readCompatJsonBody(req, res);
  if (body == null) return true;
  const socketPath =
    typeof body.socketPath === "string" ? body.socketPath.trim() : "";
  if (!socketPath || !(await consumeDesktopSocketProof(socketPath))) {
    sendJsonError(res, 403, "desktop_bootstrap_proof_failed");
    return true;
  }

  const store = new AuthStore(db);
  let owner = (await store.listIdentitiesByKind("owner"))[0] ?? null;
  const now = Date.now();
  if (!owner) {
    owner = await store.createIdentity({
      id: crypto.randomUUID(),
      kind: "owner",
      displayName: "Local",
      createdAt: now,
      passwordHash: null,
      cloudUserId: null,
    });
  }

  const { session, csrfToken } = await createBrowserSession(store, {
    identityId: owner.id,
    ip: req.socket.remoteAddress ?? null,
    userAgent: "Eliza desktop",
    rememberDevice: true,
    scopes: [DESKTOP_LOOPBACK_SESSION_SCOPE],
    now,
  });
  try {
    await appendAuditEvent(
      {
        actorIdentityId: owner.id,
        ip: req.socket.remoteAddress ?? null,
        userAgent: "Eliza desktop",
        action: "auth.desktop.bootstrap",
        outcome: "success",
        metadata: { loopback: true },
      },
      { store },
    );
  } catch (error) {
    // error-policy:J7 an audit sink failure must not orphan a valid desktop session.
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        loopback: true,
      },
      "[DesktopAuth] Bootstrap audit write failed",
    );
    try {
      state.current?.reportError("appCore.desktopAuthAudit", error, {
        loopback: true,
      });
    } catch (reportError) {
      // error-policy:J7 the structured logger above remains the observed sink.
      logger.error(
        {
          error:
            reportError instanceof Error
              ? reportError.message
              : String(reportError),
        },
        "[DesktopAuth] Runtime error reporting failed",
      );
    }
  }

  sendJson(res, 200, {
    sessionId: session.id,
    csrfToken,
    expiresAt: session.expiresAt,
  });
  return true;
}
