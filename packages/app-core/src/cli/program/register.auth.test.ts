/**
 * Unit coverage for `register.auth.ts`: loopback-gated `eliza auth reset`,
 * commander wiring, cloud API host mapping, and SIWE dev-login. Drives the
 * real module through its documented test hooks (injected store, proof
 * reader, fetch, env) — the system under test is never replaced with a mock.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthStore } from "../../services/auth-store";
import {
  registerAuthCommand,
  resolveCloudApiBase,
  runDevWalletLogin,
  runElizaAuthReset,
} from "./register.auth";

const CHALLENGE = "a".repeat(64);
const FIXED_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const savedEnv: Record<string, string | undefined> = {};
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "register-auth-"));
  for (const key of ["ELIZA_STATE_DIR", "ELIZA_NAMESPACE", "HOME"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

function proofPath(): string {
  return path.join(stateDir, "auth", "RESET_PROOF.txt");
}

function makeStore(opts?: {
  owners?: { id: string }[];
  machines?: { id: string }[];
  revokeCounts?: Record<string, number>;
}): {
  store: AuthStore;
  kinds: Array<"owner" | "machine">;
  revokes: Array<{ id: string; now: number }>;
  audits: Array<{
    action: string;
    outcome: string;
    metadata: { revoked: number };
  }>;
} {
  const kinds: Array<"owner" | "machine"> = [];
  const revokes: Array<{ id: string; now: number }> = [];
  const audits: Array<{
    action: string;
    outcome: string;
    metadata: { revoked: number };
  }> = [];
  const store = {
    async listIdentitiesByKind(kind: "owner" | "machine") {
      kinds.push(kind);
      return kind === "owner" ? (opts?.owners ?? []) : (opts?.machines ?? []);
    },
    async revokeAllSessionsForIdentity(id: string, now: number) {
      revokes.push({ id, now });
      return opts?.revokeCounts?.[id] ?? 0;
    },
    async appendAuditEvent(input: {
      action: string;
      outcome: string;
      metadata: { revoked: number };
    }) {
      audits.push(input);
      return input;
    },
  } as unknown as AuthStore;
  return { store, kinds, revokes, audits };
}

const LOOPBACK_ENV = { ELIZA_API_BIND: "127.0.0.1" };

describe("registerAuthCommand", () => {
  it("registers reset and dev-login under auth with the documented options", () => {
    const program = new Command();
    registerAuthCommand(program);

    const auth = program.commands.find((command) => command.name() === "auth");
    expect(auth).toBeDefined();
    expect(auth?.commands.map((command) => command.name()).sort()).toEqual([
      "dev-login",
      "reset",
    ]);

    const reset = auth?.commands.find((command) => command.name() === "reset");
    expect(reset?.description()).toBe("Revoke all sessions (loopback only)");

    const devLogin = auth?.commands.find(
      (command) => command.name() === "dev-login",
    );
    expect(devLogin?.options.map((option) => option.long)).toEqual([
      "--cloud",
      "--no-save",
      "--json",
    ]);
  });
});

describe("runElizaAuthReset", () => {
  it("refuses a non-loopback bind before touching proof or store", async () => {
    const { store, kinds } = makeStore();
    let readerCalls = 0;
    const result = await runElizaAuthReset({
      env: { ELIZA_API_BIND: "192.168.1.1" },
      store,
      proofReader: async () => {
        readerCalls += 1;
        return CHALLENGE;
      },
      challenge: CHALLENGE,
      log: () => {},
    });

    expect(result).toEqual({
      ok: false,
      reason: "not_loopback",
      message:
        "refusing to run: ELIZA_API_BIND=192.168.1.1 is not a loopback address",
    });
    expect(readerCalls).toBe(0);
    expect(kinds).toEqual([]);
  });

  it("refuses a wildcard bind and a public hostname the same way", async () => {
    for (const bind of ["0.0.0.0", "example.com"]) {
      const result = await runElizaAuthReset({
        env: { ELIZA_API_BIND: bind },
        store: makeStore().store,
        proofReader: async () => CHALLENGE,
        challenge: CHALLENGE,
        log: () => {},
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("not_loopback");
      expect(result.message).toContain(`ELIZA_API_BIND=${bind}`);
    }
  });

  it("treats an unset bind as the default loopback and proceeds past the gate", async () => {
    const { store } = makeStore();
    const result = await runElizaAuthReset({
      env: {},
      store,
      proofReader: async () => CHALLENGE,
      challenge: CHALLENGE,
      proofTimeoutMs: 200,
      proofPollIntervalMs: 10,
      skipProofCleanup: true,
      log: () => {},
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts localhost and ::1 as loopback binds", async () => {
    for (const bind of ["localhost", "::1"]) {
      const result = await runElizaAuthReset({
        env: { ELIZA_API_BIND: bind },
        store: makeStore().store,
        proofReader: async () => CHALLENGE,
        challenge: CHALLENGE,
        proofTimeoutMs: 200,
        proofPollIntervalMs: 10,
        skipProofCleanup: true,
        log: () => {},
      });
      expect(result).toEqual({ ok: true });
    }
  });

  it("times out when the proof file is never written", async () => {
    const result = await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store: makeStore().store,
      proofReader: async () => null,
      challenge: CHALLENGE,
      proofTimeoutMs: 80,
      proofPollIntervalMs: 20,
      log: () => {},
    });
    expect(result).toEqual({
      ok: false,
      reason: "proof_failed",
      message: "filesystem proof was not written within the timeout",
    });
  });

  it("keeps polling through a mismatched token and never resets on a miss", async () => {
    const { store, kinds } = makeStore();
    const result = await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store,
      proofReader: async () => "not-the-challenge",
      challenge: CHALLENGE,
      proofTimeoutMs: 80,
      proofPollIntervalMs: 20,
      log: () => {},
    });
    expect(result.reason).toBe("proof_failed");
    expect(kinds).toEqual([]);
  });

  it("trims surrounding whitespace on the proof token before matching", async () => {
    const result = await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store: makeStore().store,
      proofReader: async () => `  \n${CHALLENGE}\t`,
      challenge: CHALLENGE,
      proofTimeoutMs: 200,
      proofPollIntervalMs: 10,
      skipProofCleanup: true,
      log: () => {},
    });
    expect(result).toEqual({ ok: true });
  });

  it("matches on a later poll after earlier empty and mismatched reads", async () => {
    let n = 0;
    const result = await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store: makeStore().store,
      proofReader: async () => {
        n += 1;
        if (n === 1) return null;
        if (n === 2) return "wrong";
        return CHALLENGE;
      },
      challenge: CHALLENGE,
      proofTimeoutMs: 400,
      proofPollIntervalMs: 10,
      skipProofCleanup: true,
      log: () => {},
    });
    expect(result).toEqual({ ok: true });
    expect(n).toBe(3);
  });

  it("revokes zero sessions when both owner and machine queues are empty", async () => {
    const { store, kinds, revokes, audits } = makeStore();
    const lines: string[] = [];
    const result = await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store,
      proofReader: async () => CHALLENGE,
      challenge: CHALLENGE,
      proofTimeoutMs: 200,
      skipProofCleanup: true,
      log: (line) => lines.push(line),
    });

    expect(result).toEqual({ ok: true });
    expect(kinds).toEqual(["owner", "machine"]);
    expect(revokes).toEqual([]);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("auth.reset.cli");
    expect(audits[0]?.outcome).toBe("success");
    expect(audits[0]?.metadata.revoked).toBe(0);
    expect(lines.join("\n")).toContain("revoked 0 session(s)");
    expect(lines.join("\n")).toContain("Identities and password");
  });

  it("walks owners then machines in listed order and sums revoke counts", async () => {
    const { store, kinds, revokes, audits } = makeStore({
      owners: [{ id: "owner-a" }, { id: "owner-b" }],
      machines: [{ id: "machine-1" }],
      revokeCounts: { "owner-a": 2, "owner-b": 0, "machine-1": 3 },
    });
    const lines: string[] = [];
    const before = Date.now();
    const result = await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store,
      proofReader: async () => CHALLENGE,
      challenge: CHALLENGE,
      proofTimeoutMs: 200,
      skipProofCleanup: true,
      log: (line) => lines.push(line),
    });
    const after = Date.now();

    expect(result).toEqual({ ok: true });
    expect(kinds).toEqual(["owner", "machine"]);
    expect(revokes.map((entry) => entry.id)).toEqual([
      "owner-a",
      "owner-b",
      "machine-1",
    ]);
    for (const entry of revokes) {
      expect(entry.now).toBeGreaterThanOrEqual(before);
      expect(entry.now).toBeLessThanOrEqual(after);
    }
    expect(audits[0]?.metadata.revoked).toBe(5);
    expect(lines.join("\n")).toContain("revoked 5 session(s)");
  });

  it("revokes a single identity without inventing extra walks", async () => {
    const { store, revokes } = makeStore({
      owners: [{ id: "only-owner" }],
      revokeCounts: { "only-owner": 1 },
    });
    const result = await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store,
      proofReader: async () => CHALLENGE,
      challenge: CHALLENGE,
      proofTimeoutMs: 200,
      skipProofCleanup: true,
      log: () => {},
    });
    expect(result).toEqual({ ok: true });
    expect(revokes.map((entry) => entry.id)).toEqual(["only-owner"]);
  });

  it("prints the challenge and proof path before waiting", async () => {
    const lines: string[] = [];
    await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store: makeStore().store,
      proofReader: async () => CHALLENGE,
      challenge: CHALLENGE,
      proofTimeoutMs: 200,
      skipProofCleanup: true,
      log: (line) => lines.push(line),
    });
    const output = lines.join("\n");
    expect(output).toContain("Eliza auth reset");
    expect(output).toContain(CHALLENGE);
    expect(output).toContain(proofPath());
  });

  it("runs the injected cleanup hook after a successful reset", async () => {
    let cleaned = 0;
    const result = await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store: makeStore().store,
      cleanup: async () => {
        cleaned += 1;
      },
      proofReader: async () => CHALLENGE,
      challenge: CHALLENGE,
      proofTimeoutMs: 200,
      skipProofCleanup: true,
      log: () => {},
    });
    expect(result).toEqual({ ok: true });
    expect(cleaned).toBe(1);
  });

  it("does not run cleanup when proof times out", async () => {
    let cleaned = 0;
    await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store: makeStore().store,
      cleanup: async () => {
        cleaned += 1;
      },
      proofReader: async () => null,
      challenge: CHALLENGE,
      proofTimeoutMs: 50,
      proofPollIntervalMs: 10,
      log: () => {},
    });
    expect(cleaned).toBe(0);
  });

  it("reads the real proof file and deletes it on success", async () => {
    mkdirSync(path.join(stateDir, "auth"), { recursive: true });
    writeFileSync(proofPath(), CHALLENGE, "utf8");

    const result = await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store: makeStore().store,
      challenge: CHALLENGE,
      proofTimeoutMs: 200,
      proofPollIntervalMs: 10,
      log: () => {},
    });

    expect(result).toEqual({ ok: true });
    expect(() => readFileSync(proofPath())).toThrow();
  });

  it("leaves the proof file in place when skipProofCleanup is set", async () => {
    mkdirSync(path.join(stateDir, "auth"), { recursive: true });
    writeFileSync(proofPath(), CHALLENGE, "utf8");

    const result = await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store: makeStore().store,
      challenge: CHALLENGE,
      proofTimeoutMs: 200,
      skipProofCleanup: true,
      log: () => {},
    });

    expect(result).toEqual({ ok: true });
    expect(readFileSync(proofPath(), "utf8")).toBe(CHALLENGE);
  });

  it("propagates a non-ENOENT proof-file read error instead of returning store_error", async () => {
    mkdirSync(proofPath(), { recursive: true });

    await expect(
      runElizaAuthReset({
        env: LOOPBACK_ENV,
        store: makeStore().store,
        challenge: CHALLENGE,
        proofTimeoutMs: 200,
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("lets a throwing store reject rather than mapping to reason store_error", async () => {
    const store = {
      async listIdentitiesByKind() {
        throw new Error("db down");
      },
      async revokeAllSessionsForIdentity() {
        return 0;
      },
      async appendAuditEvent() {
        return {};
      },
    } as unknown as AuthStore;

    await expect(
      runElizaAuthReset({
        env: LOOPBACK_ENV,
        store,
        proofReader: async () => CHALLENGE,
        challenge: CHALLENGE,
        proofTimeoutMs: 200,
        skipProofCleanup: true,
        log: () => {},
      }),
    ).rejects.toThrow("db down");
  });

  it("writes the CLI audit event to the JSONL log with the revoked count", async () => {
    const { store } = makeStore({
      owners: [{ id: "owner-1" }],
      revokeCounts: { "owner-1": 4 },
    });
    await runElizaAuthReset({
      env: LOOPBACK_ENV,
      store,
      proofReader: async () => CHALLENGE,
      challenge: CHALLENGE,
      proofTimeoutMs: 200,
      skipProofCleanup: true,
      log: () => {},
    });

    const auditPath = path.join(stateDir, "auth", "audit.log");
    const line = JSON.parse(readFileSync(auditPath, "utf8").trim()) as {
      action: string;
      outcome: string;
      userAgent: string;
      actorIdentityId: null;
      metadata: { revoked: number };
    };
    expect(line.action).toBe("auth.reset.cli");
    expect(line.outcome).toBe("success");
    expect(line.userAgent).toBe("eliza-cli auth reset");
    expect(line.actorIdentityId).toBeNull();
    expect(line.metadata.revoked).toBe(4);
  });
});

describe("resolveCloudApiBase", () => {
  it("folds hostname case so mixed-case production hosts stay on production", () => {
    expect(resolveCloudApiBase("https://ELIZA.APP/api/v1")).toBe(
      "https://api.eliza.app",
    );
    expect(resolveCloudApiBase("https://Staging.Eliza.App")).toBe(
      "https://api-staging.eliza.app",
    );
  });

  it("treats a whitespace-only input as unparseable rather than the production default", () => {
    expect(resolveCloudApiBase("   ")).toBe("");
  });
});

describe("runDevWalletLogin", () => {
  it("fails closed when verify returns no apiKey", async () => {
    const impl = (async (url: string | URL) => {
      if (String(url).includes("/nonce")) {
        return new Response(
          JSON.stringify({
            nonce: "n1",
            domain: "www.elizacloud.ai",
            uri: "https://www.elizacloud.ai",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ address: "0xabc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await runDevWalletLogin({
      privateKey: FIXED_PK,
      save: false,
      log: () => {},
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("SIWE verify returned no apiKey");
  });

  it("takes organizationId from user.organization_id when organization is null", async () => {
    let captured = "";
    const impl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/nonce")) {
        return new Response(
          JSON.stringify({
            nonce: "n2",
            domain: "www.elizacloud.ai",
            uri: "https://www.elizacloud.ai",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        message: string;
      };
      captured = payload.message;
      return new Response(
        JSON.stringify({
          apiKey: "eliza_devkey_UNIT",
          user: { organization_id: "org-from-user" },
          organization: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await runDevWalletLogin({
      privateKey: FIXED_PK,
      save: false,
      log: () => {},
      fetchImpl: impl,
    });
    expect(result.ok).toBe(true);
    expect(result.organizationId).toBe("org-from-user");
    expect(result.savedTo).toBeNull();
    // Observed SIWE shape when the nonce omits statement, version, and chainId:
    // no statement paragraph, Version defaults to 1, Chain ID defaults to 1.
    expect(captured).toContain(
      "wants you to sign in with your Ethereum account:",
    );
    expect(captured).not.toContain("Sign in to Eliza Cloud");
    expect(captured).toContain("Version: 1");
    expect(captured).toContain("Chain ID: 1");
  });
});
