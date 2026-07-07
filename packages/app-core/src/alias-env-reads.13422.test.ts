/**
 * Proves the P2 boot-critical env reads migrated to the alias-aware reader in
 * #13422 keep the security contract: a branded `MILADY_<KEY>` resolves through
 * the real migrated call sites, the canonical `ELIZA_<KEY>` still wins when both
 * are set, and resolution never materializes the `ELIZA_` mirror on
 * `process.env` (the property the issue exists to guarantee — see
 * `packages/shared/src/utils/env.ts`). Drives the actual exported functions
 * (vault-id state-dir derivation, the steward sidecar factory, steward
 * credential load, edge-TTS disable) plus the startEliza port/orchestrator
 * decision expressions, not the reader in isolation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getBootConfig,
  readAliasedEnv,
  resolveDesktopApiPort,
  resolveServerOnlyPort,
  setBootConfig,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isTextToSpeechProviderDisabled,
  type TextToSpeechProviderConfig,
} from "./runtime/tts-provider-registry.ts";
import {
  deriveAgentVaultId,
  resolveCanonicalStateDir,
} from "./security/agent-vault-id.ts";
import type { PlatformSecureStore } from "./security/platform-secure-store.ts";
import { loadStewardCredentials } from "./services/steward-credentials.ts";
import { createDesktopStewardSidecar } from "./services/steward-sidecar.ts";

const BRAND = "MILADY";

// The exact P2 partition keys migrated in #13422, paired with the branded
// prefix a Milady deployment sets. Resolution must never write the ELIZA_ side.
const ALIAS_PAIRS: Array<readonly [string, string]> = [
  [`${BRAND}_STATE_DIR`, "ELIZA_STATE_DIR"],
  [`${BRAND}_NAMESPACE`, "ELIZA_NAMESPACE"],
  [`${BRAND}_AGENT_ORCHESTRATOR`, "ELIZA_AGENT_ORCHESTRATOR"],
  [`${BRAND}_API_PORT`, "ELIZA_API_PORT"],
  [`${BRAND}_DISABLE_EDGE_TTS`, "ELIZA_DISABLE_EDGE_TTS"],
];
const TRACKED = [
  ...new Set([
    ...ALIAS_PAIRS.flat(),
    "XDG_STATE_HOME",
    "STEWARD_DATA_DIR",
    // Cleared so the server-only-port default (2138) is deterministic.
    "ELIZA_PORT",
    "ELIZA_UI_PORT",
  ]),
];

const savedConfig = getBootConfig();
const savedEnv: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-13422-"));
  tempDirs.push(dir);
  return dir;
}

// A secure store whose backend is unavailable, so credential load falls to the
// plaintext metadata file — the path we exercise here. Injected via the
// function's own `secureStore` option, so it is a dependency stand-in, not a
// stub of the code under test.
const unavailableSecureStore: PlatformSecureStore = {
  backend: "none",
  get: async () => ({ ok: false, reason: "unavailable" }),
  set: async () => ({ ok: false, reason: "unavailable" }),
  delete: async () => {},
  isAvailable: async () => false,
};

beforeEach(() => {
  for (const key of TRACKED) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Pin the alias table on the immutable BootConfig, exactly as the branded app
  // boot does — this is what makes MILADY_* resolvable without the env mirror.
  setBootConfig({ ...savedConfig, envAliases: ALIAS_PAIRS });
});

afterEach(() => {
  for (const key of TRACKED) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setBootConfig(savedConfig);
});

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent-vault-id state dir (ELIZA_STATE_DIR + ELIZA_NAMESPACE)", () => {
  it("derives the canonical state dir from a branded MILADY_STATE_DIR without the mirror", () => {
    process.env.MILADY_STATE_DIR = "/var/milady/state";

    // resolveCanonicalStateDir path.resolve()s the dir, so on Windows the POSIX
    // literal canonicalizes to a drive-anchored path (D:\var\milady\state).
    // Assert against the same resolution so the check is platform-portable.
    const expected = path.resolve("/var/milady/state");
    expect(resolveCanonicalStateDir()).toBe(expected);
    // The vault id is a deterministic hash of that resolved dir — proves the
    // branded value actually flowed into the keychain namespace.
    expect(deriveAgentVaultId()).toBe(deriveAgentVaultId(expected));
    // Security property: the read must not synthesize the ELIZA_ mirror.
    expect(process.env.ELIZA_STATE_DIR).toBeUndefined();
  });

  it("prefers the canonical ELIZA_STATE_DIR over the branded alias", () => {
    process.env.ELIZA_STATE_DIR = "/var/eliza/state";
    process.env.MILADY_STATE_DIR = "/var/milady/state";

    expect(resolveCanonicalStateDir()).toBe(path.resolve("/var/eliza/state"));
  });

  it("derives the state dir from a branded MILADY_NAMESPACE", () => {
    const xdg = makeTempDir();
    process.env.XDG_STATE_HOME = xdg;
    process.env.MILADY_NAMESPACE = "miladybrand";

    expect(resolveCanonicalStateDir()).toBe(path.join(xdg, "miladybrand"));
    expect(process.env.ELIZA_NAMESPACE).toBeUndefined();
  });
});

describe("steward sidecar data dir (ELIZA_NAMESPACE)", () => {
  // The sidecar exposes no public data-dir getter, so read the resolved config
  // it built from the (migrated) namespace read.
  const dataDirOf = (sidecar: unknown): string =>
    (sidecar as { config: { dataDir: string } }).config.dataDir;

  it("builds the sidecar data dir from a branded MILADY_NAMESPACE", () => {
    const xdg = makeTempDir();
    process.env.XDG_STATE_HOME = xdg;
    process.env.MILADY_NAMESPACE = "miladybrand";

    const sidecar = createDesktopStewardSidecar();
    expect(dataDirOf(sidecar)).toBe(path.join(xdg, "miladybrand", "steward"));
    expect(process.env.ELIZA_NAMESPACE).toBeUndefined();
  });

  it("prefers the canonical ELIZA_NAMESPACE over the branded alias", () => {
    const xdg = makeTempDir();
    process.env.XDG_STATE_HOME = xdg;
    process.env.ELIZA_NAMESPACE = "elizabrand";
    process.env.MILADY_NAMESPACE = "miladybrand";

    const sidecar = createDesktopStewardSidecar();
    expect(dataDirOf(sidecar)).toBe(path.join(xdg, "elizabrand", "steward"));
  });
});

describe("steward credentials load (ELIZA_STATE_DIR)", () => {
  function writeCredentials(dir: string): void {
    fs.writeFileSync(
      path.join(dir, "steward-credentials.json"),
      JSON.stringify({
        apiUrl: "https://steward.milady.test",
        tenantId: "tenant-milady",
        agentId: "agent-milady",
      }),
    );
  }

  it("reads persisted credentials from a branded MILADY_STATE_DIR", async () => {
    const dir = makeTempDir();
    writeCredentials(dir);
    process.env.MILADY_STATE_DIR = dir;

    const creds = await loadStewardCredentials({
      secureStore: unavailableSecureStore,
    });

    expect(creds).not.toBeNull();
    expect(creds?.apiUrl).toBe("https://steward.milady.test");
    expect(creds?.tenantId).toBe("tenant-milady");
    expect(creds?.agentId).toBe("agent-milady");
    expect(process.env.ELIZA_STATE_DIR).toBeUndefined();
  });

  it("prefers the canonical ELIZA_STATE_DIR over the branded alias", async () => {
    const branded = makeTempDir();
    writeCredentials(branded);
    const canonicalEmpty = makeTempDir(); // no credentials file here
    process.env.MILADY_STATE_DIR = branded;
    process.env.ELIZA_STATE_DIR = canonicalEmpty;

    // ELIZA_ wins, so the load looks in the empty dir and finds nothing.
    const creds = await loadStewardCredentials({
      secureStore: unavailableSecureStore,
    });
    expect(creds).toBeNull();
  });
});

describe("edge-TTS disable check (ELIZA_DISABLE_EDGE_TTS)", () => {
  const config: TextToSpeechProviderConfig = {};

  it("honors a branded MILADY_DISABLE_EDGE_TTS", () => {
    for (const token of ["1", "true", "yes"]) {
      process.env.MILADY_DISABLE_EDGE_TTS = token;
      expect(isTextToSpeechProviderDisabled(config)).toBe(true);
    }
  });

  it("stays enabled when unset, and never writes the mirror", () => {
    expect(isTextToSpeechProviderDisabled(config)).toBe(false);
    isTextToSpeechProviderDisabled(config);
    expect(process.env.ELIZA_DISABLE_EDGE_TTS).toBeUndefined();
  });

  it("prefers the canonical ELIZA_DISABLE_EDGE_TTS over the branded alias", () => {
    // Canonical "0" wins over branded "1": the feature stays enabled.
    process.env.ELIZA_DISABLE_EDGE_TTS = "0";
    process.env.MILADY_DISABLE_EDGE_TTS = "1";
    expect(isTextToSpeechProviderDisabled(config)).toBe(false);
  });
});

describe("startEliza boot decision reads (ELIZA_AGENT_ORCHESTRATOR + ELIZA_API_PORT)", () => {
  // startEliza boots the whole runtime, so assert the exact alias-aware
  // expressions its migrated lines evaluate (eliza.ts orchestrator gate + api
  // port branch), against the real shared resolvers those lines call.
  it("resolves the orchestrator gate from a branded MILADY_AGENT_ORCHESTRATOR", () => {
    process.env.MILADY_AGENT_ORCHESTRATOR = "0";
    expect(readAliasedEnv("ELIZA_AGENT_ORCHESTRATOR")?.toLowerCase()).toBe("0");
    expect(process.env.ELIZA_AGENT_ORCHESTRATOR).toBeUndefined();
  });

  it("prefers the canonical ELIZA_AGENT_ORCHESTRATOR over the branded alias", () => {
    process.env.ELIZA_AGENT_ORCHESTRATOR = "1";
    process.env.MILADY_AGENT_ORCHESTRATOR = "0";
    expect(readAliasedEnv("ELIZA_AGENT_ORCHESTRATOR")?.toLowerCase()).toBe("1");
  });

  it("selects the desktop port when a branded MILADY_API_PORT is set", () => {
    process.env.MILADY_API_PORT = "7777";
    // The migrated branch condition (alias-aware) and the resolver it calls.
    expect(Boolean(readAliasedEnv("ELIZA_API_PORT"))).toBe(true);
    expect(resolveDesktopApiPort(process.env)).toBe(7777);
    expect(process.env.ELIZA_API_PORT).toBeUndefined();
  });

  it("falls back to the server-only port when no API port is configured", () => {
    expect(Boolean(readAliasedEnv("ELIZA_API_PORT"))).toBe(false);
    expect(resolveServerOnlyPort(process.env)).toBe(2138);
  });

  it("prefers the canonical ELIZA_API_PORT over the branded alias", () => {
    process.env.ELIZA_API_PORT = "8888";
    process.env.MILADY_API_PORT = "7777";
    expect(resolveDesktopApiPort(process.env)).toBe(8888);
  });
});
