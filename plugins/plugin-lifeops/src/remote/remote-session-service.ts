/**
 * Control-plane service for remote VNC / remote-control sessions (T9a).
 *
 * This module owns:
 *   - Session lifecycle (pending → active → denied/revoked).
 *   - Pairing-code issuance and verification.
 *   - Local-mode bypass (ELIZA_REMOTE_LOCAL_MODE=1 skips the code requirement
 *     but still requires explicit `confirmed: true`).
 *   - Data-plane handoff point (`ingressUrl`).
 *
 * It does NOT own pixel transport. The data plane (VNC / Tailscale / Eliza
 * Cloud tunnel) is separate infrastructure. When no data plane is configured,
 * `startSession` returns an explicit `ingressUrl: null` with a structured
 * `reason: "data-plane-not-configured"` — this is deliberate absence, not a
 * fallback that pretends the session is usable.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "@elizaos/agent";
import { logger } from "@elizaos/core";
import { PairingCodeStore } from "./pairing-code.js";

export type RemoteSessionStatus = "pending" | "active" | "denied" | "revoked";

export type DataPlaneUnavailableReason =
  | "data-plane-not-configured"
  | "local-mode-no-ingress";

export interface RemoteSession {
  id: string;
  requesterIdentity: string;
  status: RemoteSessionStatus;
  /**
   * Ingress URL for the data plane (e.g. `vnc://host.ts.net:5900` or a cloud
   * tunnel endpoint). Null when no data plane is wired up — see `reason`.
   */
  ingressUrl: string | null;
  /**
   * Present only when `ingressUrl` is null. Explicit structured absence.
   */
  reason: DataPlaneUnavailableReason | null;
  localMode: boolean;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface StartSessionParams {
  requesterIdentity: string;
  pairingCode?: string;
  confirmed: boolean;
}

export interface StartSessionResult {
  sessionId: string;
  status: RemoteSessionStatus;
  ingressUrl: string | null;
  reason: DataPlaneUnavailableReason | null;
  localMode: boolean;
}

export interface DataPlaneResolution {
  ingressUrl: string | null;
  reason: DataPlaneUnavailableReason | null;
}

export interface DataPlaneResolver {
  /**
   * Returns the ingress URL for this session, or an explicit reason absence.
   * Implementations live in T9b (Tailscale) and the Eliza Cloud tunnel track.
   */
  resolve(session: {
    sessionId: string;
    requesterIdentity: string;
    localMode: boolean;
  }): Promise<DataPlaneResolution> | DataPlaneResolution;
}

export interface RemoteSessionServiceOptions {
  pairingCodes?: PairingCodeStore;
  dataPlane?: DataPlaneResolver;
  /** Read once per `startSession` call; overridable for tests. */
  isLocalMode?: () => boolean;
  now?: () => Date;
  logger?: Pick<typeof logger, "info" | "warn" | "debug">;
  storagePath?: string;
}

export class RemoteSessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteSessionError";
    this.code = code;
  }
}

const PAIRING_SUBJECT = "agent";

function defaultIsLocalMode(): boolean {
  return process.env.ELIZA_REMOTE_LOCAL_MODE === "1";
}

const nullDataPlane: DataPlaneResolver = {
  resolve: () => ({
    ingressUrl: null,
    reason: "data-plane-not-configured",
  }),
};

function defaultStoragePath(): string {
  return path.join(resolveStateDir(), "lifeops", "remote-sessions.json");
}

export class RemoteSessionService {
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly pairingCodes: PairingCodeStore;
  private readonly dataPlane: DataPlaneResolver;
  private readonly isLocalMode: () => boolean;
  private readonly now: () => Date;
  private readonly log: Pick<typeof logger, "info" | "warn" | "debug">;
  private readonly storagePath: string;

  constructor(options: RemoteSessionServiceOptions = {}) {
    this.pairingCodes = options.pairingCodes ?? new PairingCodeStore();
    this.dataPlane = options.dataPlane ?? nullDataPlane;
    this.isLocalMode = options.isLocalMode ?? defaultIsLocalMode;
    this.now = options.now ?? (() => new Date());
    this.log = options.logger ?? logger;
    this.storagePath = options.storagePath ?? defaultStoragePath();
    this.loadSessions();
  }

  /**
   * Issue a fresh pairing code. Each call rotates the code (one-time use).
   * Returns the code so it can be displayed to the owner out-of-band.
   */
  issuePairingCode(): { code: string; expiresAt: string } {
    const entry = this.pairingCodes.issue(PAIRING_SUBJECT);
    return {
      code: entry.code,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    };
  }

  async startSession(params: StartSessionParams): Promise<StartSessionResult> {
    if (!params.confirmed) {
      throw new RemoteSessionError(
        "NOT_CONFIRMED",
        "Remote sessions require explicit confirmation (confirmed: true).",
      );
    }
    const requester = params.requesterIdentity.trim();
    if (!requester) {
      throw new RemoteSessionError(
        "MISSING_REQUESTER",
        "requesterIdentity is required.",
      );
    }

    const localMode = this.isLocalMode();
    let status: RemoteSessionStatus = "pending";

    if (!localMode) {
      const code = params.pairingCode?.trim();
      if (!code) {
        throw new RemoteSessionError(
          "PAIRING_CODE_REQUIRED",
          "Pairing code required for non-local sessions. Issue one with issuePairingCode() first.",
        );
      }
      const ok = this.pairingCodes.consume(PAIRING_SUBJECT, code);
      if (!ok) {
        const denied = this.recordSession({
          requesterIdentity: requester,
          status: "denied",
          ingressUrl: null,
          reason: null,
          localMode,
        });
        this.log.warn(
          { boundary: "remote", sessionId: denied.id, requester },
          "[RemoteSessionService] pairing-code rejected",
        );
        return {
          sessionId: denied.id,
          status: "denied",
          ingressUrl: null,
          reason: null,
          localMode,
        };
      }
      status = "active";
    } else {
      status = "active";
    }

    const resolved = await this.dataPlane.resolve({
      sessionId: "pending",
      requesterIdentity: requester,
      localMode,
    });

    const session = this.recordSession({
      requesterIdentity: requester,
      status,
      ingressUrl: resolved.ingressUrl,
      reason: resolved.reason,
      localMode,
    });

    if (resolved.ingressUrl === null) {
      this.log.info(
        {
          boundary: "remote",
          sessionId: session.id,
          reason: resolved.reason,
          localMode,
        },
        `[RemoteSessionService] session ${session.id} active but no data plane ingress (reason=${resolved.reason ?? "unknown"})`,
      );
    } else {
      this.log.info(
        {
          boundary: "remote",
          sessionId: session.id,
          localMode,
        },
        `[RemoteSessionService] session ${session.id} active`,
      );
    }

    return {
      sessionId: session.id,
      status,
      ingressUrl: session.ingressUrl,
      reason: session.reason,
      localMode,
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RemoteSessionError(
        "SESSION_NOT_FOUND",
        `No session found with id ${sessionId}.`,
      );
    }
    if (session.status === "revoked" || session.status === "denied") {
      return;
    }
    const endedAt = this.now().toISOString();
    const revoked: RemoteSession = {
      ...session,
      status: "revoked",
      updatedAt: endedAt,
      endedAt,
    };
    this.sessions.set(sessionId, revoked);
    this.persistSessions();
    this.log.info(
      { boundary: "remote", sessionId },
      `[RemoteSessionService] session ${sessionId} revoked`,
    );
  }

  async listActiveSessions(): Promise<RemoteSession[]> {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === "active" || s.status === "pending",
    );
  }

  async getSession(sessionId: string): Promise<RemoteSession | undefined> {
    return this.sessions.get(sessionId);
  }

  private recordSession(input: {
    requesterIdentity: string;
    status: RemoteSessionStatus;
    ingressUrl: string | null;
    reason: DataPlaneUnavailableReason | null;
    localMode: boolean;
  }): RemoteSession {
    const id = randomUUID();
    const nowIso = this.now().toISOString();
    const session: RemoteSession = {
      id,
      requesterIdentity: input.requesterIdentity,
      status: input.status,
      ingressUrl: input.ingressUrl,
      reason: input.reason,
      localMode: input.localMode,
      createdAt: nowIso,
      updatedAt: nowIso,
      endedAt:
        input.status === "denied" || input.status === "revoked" ? nowIso : null,
    };
    this.sessions.set(id, session);
    this.persistSessions();
    return session;
  }

  private loadSessions(): void {
    if (!fs.existsSync(this.storagePath)) {
      return;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.storagePath, "utf8"),
      ) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const session = entry as Partial<RemoteSession>;
        if (
          typeof session.id !== "string" ||
          typeof session.requesterIdentity !== "string" ||
          typeof session.status !== "string" ||
          typeof session.localMode !== "boolean" ||
          typeof session.createdAt !== "string" ||
          typeof session.updatedAt !== "string"
        ) {
          continue;
        }
        this.sessions.set(session.id, {
          id: session.id,
          requesterIdentity: session.requesterIdentity,
          status:
            session.status === "active" ||
            session.status === "pending" ||
            session.status === "denied" ||
            session.status === "revoked"
              ? session.status
              : "revoked",
          ingressUrl:
            typeof session.ingressUrl === "string" ? session.ingressUrl : null,
          reason:
            session.reason === "data-plane-not-configured" ||
            session.reason === "local-mode-no-ingress"
              ? session.reason
              : null,
          localMode: session.localMode,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          endedAt: typeof session.endedAt === "string" ? session.endedAt : null,
        });
      }
    } catch {
      // Invalid persisted state is ignored so a new process can recreate it.
    }
  }

  private persistSessions(): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    fs.writeFileSync(
      this.storagePath,
      JSON.stringify(Array.from(this.sessions.values()), null, 2),
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  }
}

let singleton: RemoteSessionService | undefined;

export function getRemoteSessionService(): RemoteSessionService {
  if (!singleton) {
    singleton = new RemoteSessionService();
  }
  return singleton;
}

/** Test-only hook for resetting the singleton between tests. */
export function __resetRemoteSessionServiceForTests(): void {
  singleton = undefined;
}
