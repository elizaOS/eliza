/**
 * Standalone-entrypoint topology regression for #18080: connect → full process
 * restart → credential-state read, on the shipped Cloud image topology. Each
 * phase spawns the REAL standalone boot (`connector-oauth-topology-child.ts` →
 * `startElizaProcess`, the same path `bin.js start` runs) as a separate `bun`
 * process over a shared temp `ELIZA_STATE_DIR`/PGlite store; a restart is a
 * genuinely new OS process reusing only that durable state. Only Google's
 * token HTTP response is stubbed via a loopback server + `ELIZA_MOCK_GOOGLE_BASE`;
 * runtime, plugin resolution, host bridge (no-op vault ⇒ `hasDurableHostVault()`
 * false, credential store never registers), manager, provider, and SQL storage
 * are all real.
 *
 * Covers both sides of the #18080 product contract:
 * - Cloud-provisioned (`ELIZA_CLOUD_PROVISIONED=1`): OAuth completion fails
 *   closed with `CONNECTOR_CREDENTIAL_WRITER_UNAVAILABLE`, the consumed flow
 *   persists as failed (surviving the restart), and no account ever carries a
 *   credential ref.
 * - Hostless local desktop/dev (no cloud flag): keep-until-restart — the
 *   volatile SECRETS write succeeds, the account connects flagged
 *   `credentialRefStorage.volatile`, and the ref visibly dangles after restart
 *   (refs persisted, secret material gone with the old process).
 *
 * Boots the full runtime twice per case (~30-60s each) — kept in the
 * integration lane; run with `bun run --cwd packages/agent test:integration`
 * or target this file directly.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  HERE,
  "fixtures",
  "connector-oauth-topology-child.ts",
);

interface AccountSnapshot {
  id: string;
  status: string;
  hasCredentialRefs: boolean;
  volatile: boolean | null;
}

interface TopologyResult {
  mode: string;
  hasDurableHostVault?: boolean;
  storeRegistered?: boolean;
  state?: string;
  completed?: boolean;
  completedAccountStatus?: string | null;
  completionError?: string;
  completionErrorCode?: string | null;
  flowStatus?: string | null;
  flowError?: string | null;
  flowErrorCode?: string | null;
  accounts?: AccountSnapshot[];
  driverError?: string;
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

let tokenServer: http.Server;
let mockGoogleBase = "";
const stateDirs: string[] = [];

beforeAll(async () => {
  tokenServer = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/token") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          access_token: "topology-access-token",
          refresh_token: "topology-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          id_token: unsignedJwt({
            sub: "google-sub-topology",
            email: "owner@example.com",
            email_verified: true,
            name: "Owner",
          }),
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) =>
    tokenServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = tokenServer.address() as AddressInfo;
  mockGoogleBase = `http://127.0.0.1:${port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    tokenServer.close((err) => (err ? reject(err) : resolve())),
  );
  for (const dir of stateDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function newStateDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  stateDirs.push(dir);
  // Google client config the way a standalone operator supplies it: agent
  // settings in the state dir's eliza.json (runtime.getSetting deliberately
  // never reads process.env). The redirect URI is never dereferenced — the
  // child drives completeOAuth directly, as the callback route would.
  fs.writeFileSync(
    path.join(dir, "eliza.json"),
    JSON.stringify({
      agents: {
        list: [
          {
            name: "Topology",
            settings: {
              GOOGLE_CLIENT_ID: "topology-client",
              GOOGLE_CLIENT_SECRET: "topology-secret",
              GOOGLE_REDIRECT_URI:
                "http://127.0.0.1:39181/api/connectors/google/oauth/callback",
            },
          },
        ],
      },
    }),
  );
  return dir;
}

function runChild(
  stateDir: string,
  env: Record<string, string>,
  timeoutMs = 180_000,
): Promise<TopologyResult> {
  return new Promise((resolve, reject) => {
    // The vitest parent env may carry ALLOW_NO_DATABASE (unit-lane default);
    // this e2e requires the real PGlite-backed adapter, like the deployment.
    const parentEnv = { ...process.env };
    delete parentEnv.ALLOW_NO_DATABASE;
    delete parentEnv.ELIZA_CLOUD_PROVISIONED;
    const child = spawn("bun", ["--conditions=eliza-source", FIXTURE], {
      cwd: path.join(HERE, ".."),
      env: {
        ...parentEnv,
        NODE_ENV: "test",
        LOG_LEVEL: "fatal",
        ELIZA_STATE_DIR: stateDir,
        PGLITE_DATA_DIR: path.join(stateDir, "pglite"),
        GOOGLE_CLIENT_ID: "topology-client",
        GOOGLE_CLIENT_SECRET: "topology-secret",
        GOOGLE_REDIRECT_URI:
          "http://127.0.0.1:39181/api/connectors/google/oauth/callback",
        ELIZA_MOCK_GOOGLE_BASE: mockGoogleBase,
        ELIZA_API_PORT: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`topology child timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      const line = stdout
        .split("\n")
        .find((candidate) => candidate.startsWith("TOPOLOGY_RESULT="));
      if (!line) {
        reject(
          new Error(
            `topology child produced no result. stdout tail: ${stdout.slice(-2000)} stderr tail: ${stderr.slice(-2000)}`,
          ),
        );
        return;
      }
      resolve(JSON.parse(line.slice("TOPOLOGY_RESULT=".length)));
    });
    child.on("error", reject);
  });
}

describe("standalone entrypoint connector-credential topology (#18080)", () => {
  it("Cloud-provisioned image: OAuth completion fails closed, the failed flow survives a full process restart, no credential ref ever lands", async () => {
    const stateDir = newStateDir("eliza-18080-cloud-");
    const cloudEnv = { ELIZA_CLOUD_PROVISIONED: "1" };

    const connect = await runChild(stateDir, {
      ...cloudEnv,
      TOPOLOGY_MODE: "connect",
    });
    expect(connect.driverError).toBeUndefined();
    // The shipped Cloud image topology: default no-op vault, store skipped.
    expect(connect.hasDurableHostVault).toBe(false);
    expect(connect.storeRegistered).toBe(false);
    // Completion fails closed with the stable typed code…
    expect(connect.completed).toBe(false);
    expect(connect.completionError).toMatch(
      /No durable connector credential store or vault writer/,
    );
    expect(connect.completionErrorCode).toBe(
      "CONNECTOR_CREDENTIAL_WRITER_UNAVAILABLE",
    );
    // …and the consumed flow is terminally failed, not pending forever.
    expect(connect.flowStatus).toBe("failed");
    expect(connect.flowErrorCode).toBe(
      "CONNECTOR_CREDENTIAL_WRITER_UNAVAILABLE",
    );
    expect(connect.accounts?.every((a) => a.status === "pending")).toBe(true);
    expect(connect.accounts?.every((a) => !a.hasCredentialRefs)).toBe(true);

    // Full process restart: brand-new OS process over the same durable state.
    const inspect = await runChild(stateDir, {
      ...cloudEnv,
      TOPOLOGY_MODE: "inspect",
      TOPOLOGY_STATE: connect.state ?? "",
    });
    expect(inspect.driverError).toBeUndefined();
    expect(inspect.flowStatus).toBe("failed");
    expect(inspect.flowError).toMatch(
      /No durable connector credential store or vault writer/,
    );
    expect(inspect.accounts?.every((a) => a.status === "pending")).toBe(true);
    expect(inspect.accounts?.every((a) => !a.hasCredentialRefs)).toBe(true);
  }, 420_000);

  it("hostless local desktop/dev: keep-until-restart — connect succeeds flagged volatile, and the ref visibly dangles after a restart", async () => {
    const stateDir = newStateDir("eliza-18080-desktop-");

    const connect = await runChild(stateDir, { TOPOLOGY_MODE: "connect" });
    expect(connect.driverError).toBeUndefined();
    expect(connect.hasDurableHostVault).toBe(false);
    // Pre-#19038 desktop behavior preserved: the volatile write connects the
    // account, marked volatile so surfaces can warn about the restart window.
    expect(connect.completed).toBe(true);
    expect(connect.completedAccountStatus).toBe("connected");
    const connected = connect.accounts?.find((a) => a.status === "connected");
    expect(connected?.hasCredentialRefs).toBe(true);
    expect(connected?.volatile).toBe(true);

    // Restart: refs persisted durably, secret material died with the process —
    // the documented keep-until-restart window, now explicit instead of silent.
    const inspect = await runChild(stateDir, {
      TOPOLOGY_MODE: "inspect",
      TOPOLOGY_STATE: connect.state ?? "",
    });
    expect(inspect.driverError).toBeUndefined();
    expect(inspect.flowStatus).toBe("completed");
    const after = inspect.accounts?.find((a) => a.id === connected?.id);
    expect(after?.status).toBe("connected");
    expect(after?.hasCredentialRefs).toBe(true);
    expect(after?.volatile).toBe(true);
  }, 420_000);
});
