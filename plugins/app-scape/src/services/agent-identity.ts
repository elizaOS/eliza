/**
 * Agent identity — self-generated name + password for the 'scape
 * agent, persisted so subsequent runs reuse the same xRSPS account.
 *
 * Why self-generate: the dev workflow should be zero-friction. The
 * operator starts `bun run dev` (or the eliza runtime) and the agent
 * connects without the operator having to think about credentials.
 * The SAME identity is reused on every subsequent run so skills,
 * inventory, position, and the Scape Journal accumulate across
 * sessions — each run feels like the same character picking up where
 * they left off.
 *
 * Priority order for each field:
 *   1. Explicit runtime setting (`SCAPE_AGENT_NAME`, `SCAPE_AGENT_PASSWORD`,
 *      `SCAPE_AGENT_ID`) — lets an operator pin a specific identity.
 *   2. Previously-persisted identity file at
 *      `~/.eliza/scape-agent-identity.json` (or the override path
 *      passed to the function).
 *   3. Freshly generated value — written to the identity file so
 *      the next run picks it up.
 *
 * The identity file is co-located with the Scape Journal directory
 * (`~/.eliza/scape-journals/`) so everything 'scape writes to disk
 * lives in one place and can be backed up / wiped together.
 *
 * SECURITY: the password is persisted in plaintext. For the default
 * auto-generated throwaway account, this is fine — the password only
 * authorizes this one machine to play one xRSPS character, and a
 * compromised laptop already leaks everything else in `~/.eliza/`.
 * But if an operator passes `SCAPE_AGENT_PASSWORD` (or an override
 * from a plugin parameter in the eliza UI) pointing at a real
 * account, that password will silently land on disk. We log a WARN
 * at write time so it's visible in the service startup log, and the
 * `SCAPE_AGENT_PASSWORD` plugin parameter description spells this out
 * explicitly. Do NOT reuse a production password here.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AgentIdentity {
  /** Stable agent id across reconnects. Used as the journal filename. */
  agentId: string;
  /** In-game display name. Becomes the account username. */
  displayName: string;
  /** Plaintext password used for scrypt verification / auto-registration. */
  password: string;
  /** Unix millis when the identity was first generated. */
  createdAt: number;
}

export interface AgentIdentityOverrides {
  agentId?: string;
  displayName?: string;
  password?: string;
}

export interface AgentIdentityOptions {
  /** Absolute override path for the identity file. Tests use this. */
  filePath?: string;
  /** Explicit overrides that trump both the file and generation. */
  overrides?: AgentIdentityOverrides;
  /** Log sink for lifecycle messages. */
  log?: (line: string) => void;
}

function defaultIdentityPath(): string {
  return join(homedir(), ".eliza", "scape-agent-identity.json");
}

/**
 * Produce a name that fits the server's 12-char display-name budget.
 * Shape: `agent-XXXXXX` — exactly 12 chars, ~16.7M possibilities.
 */
function generateDisplayName(): string {
  const suffix = randomBytes(3).toString("hex"); // 6 hex chars
  return `agent-${suffix}`;
}

/**
 * 24-character base64url password from 18 random bytes. Well above
 * the server's 8-char minimum, comfortable margin against brute force.
 */
function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

function isValidIdentity(value: unknown): value is AgentIdentity {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.agentId === "string" &&
    obj.agentId.length > 0 &&
    typeof obj.displayName === "string" &&
    obj.displayName.length > 0 &&
    typeof obj.password === "string" &&
    obj.password.length >= 8 &&
    typeof obj.createdAt === "number"
  );
}

/**
 * Load the agent identity, or generate + persist a new one.
 *
 * This is called exactly once at service startup. The returned
 * identity is the canonical one for the entire run; callers should
 * cache it rather than re-calling this function mid-session.
 */
export function loadOrGenerateAgentIdentity(
  options: AgentIdentityOptions = {},
): AgentIdentity {
  const filePath = options.filePath ?? defaultIdentityPath();
  const log = options.log ?? (() => {});
  const overrides = options.overrides ?? {};

  // 1. Try to load existing identity
  let fromFile: AgentIdentity | null = null;
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (isValidIdentity(parsed)) {
        fromFile = parsed;
      } else {
        log(`agent identity file at ${filePath} is malformed, regenerating`);
      }
    } catch (err) {
      log(
        `failed to read agent identity ${filePath}: ${err instanceof Error ? err.message : String(err)} — regenerating`,
      );
    }
  }

  // 2. Merge: overrides > file > fresh generation
  const displayName =
    overrides.displayName ?? fromFile?.displayName ?? generateDisplayName();
  const passwordWasOverridden =
    typeof overrides.password === "string" && overrides.password.length > 0;
  const password =
    overrides.password ?? fromFile?.password ?? generatePassword();
  const agentId =
    overrides.agentId ?? fromFile?.agentId ?? `scape-${displayName}`;
  const createdAt = fromFile?.createdAt ?? Date.now();

  // SECURITY WARN: the operator set SCAPE_AGENT_PASSWORD explicitly,
  // and we're about to write that value to disk in plaintext. Log
  // once (loudly) so it shows up in the service startup log.
  if (passwordWasOverridden) {
    log(
      "WARNING: SCAPE_AGENT_PASSWORD was set via runtime override; the value will be persisted to the identity file in PLAINTEXT. Do not reuse a production password here.",
    );
  }

  const identity: AgentIdentity = {
    agentId,
    displayName,
    password,
    createdAt,
  };

  // 3. Persist any changes so the next run lines up. We always
  //    write because even with a valid file, `createdAt` might be
  //    ancient and we want to keep the file timestamp fresh.
  const needsWrite =
    fromFile === null ||
    fromFile.displayName !== identity.displayName ||
    fromFile.password !== identity.password ||
    fromFile.agentId !== identity.agentId;

  if (needsWrite) {
    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`);
      renameSync(tmp, filePath);
      log(
        fromFile
          ? `updated agent identity at ${filePath}`
          : `generated new agent identity at ${filePath}`,
      );
    } catch (err) {
      log(
        `failed to persist agent identity to ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return identity;
}
