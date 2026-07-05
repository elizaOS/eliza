/**
 * Proves #13422: the vision-language bench model-dir mirror resolves a NON-ELIZA
 * brand prefix (MILADY_STATE_DIR / MILADY_NAMESPACE) through the boot-config
 * alias table via core's non-mutating reader — canonical ELIZA_ wins, empty is
 * unset, and no ELIZA_ mirror is written. Real function + real resolver, no
 * mocks; only the boot-config global slot and process.env are saved/restored.
 */
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { elizaModelsDir } from "../src/runtime-resolver.ts";

const STORE_KEY = Symbol.for("elizaos.app.boot-config");
const WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";
type Slot = Record<PropertyKey, unknown>;

// A NON-ELIZA prefix is the security-relevant fixture; an ELIZA->ELIZA
// self-mirror would prove nothing about brand-alias resolution.
const MILADY_ALIASES = [
  ["MILADY_STATE_DIR", "ELIZA_STATE_DIR"],
  ["MILADY_NAMESPACE", "ELIZA_NAMESPACE"],
] as const;

describe("elizaModelsDir resolves a branded prefix without the sync mirror (#13422)", () => {
  const tracked = [
    "MILADY_STATE_DIR",
    "ELIZA_STATE_DIR",
    "MILADY_NAMESPACE",
    "ELIZA_NAMESPACE",
  ];
  const savedEnv: Record<string, string | undefined> = {};
  let savedStore: unknown;
  let savedWindow: unknown;

  beforeEach(() => {
    const slot = globalThis as Slot;
    savedStore = slot[STORE_KEY];
    savedWindow = slot[WINDOW_KEY];
    for (const key of tracked) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Install the alias table exactly as the branded app boot does; this is what
    // makes the resolver's default alias source resolve branded keys.
    slot[STORE_KEY] = { current: { envAliases: MILADY_ALIASES } };
  });

  afterEach(() => {
    const slot = globalThis as Slot;
    if (savedStore === undefined) delete slot[STORE_KEY];
    else slot[STORE_KEY] = savedStore;
    if (savedWindow === undefined) delete slot[WINDOW_KEY];
    else slot[WINDOW_KEY] = savedWindow;
    for (const key of tracked) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("derives the models dir from a branded MILADY_STATE_DIR with zero mirror writes", () => {
    process.env.MILADY_STATE_DIR = "/var/milady/state";
    const before = { ...process.env };

    expect(elizaModelsDir()).toBe(
      path.join("/var/milady/state", "local-inference", "models"),
    );

    // The migrated read must not materialize the ELIZA_ target.
    expect(process.env.ELIZA_STATE_DIR).toBeUndefined();
    expect(process.env).toEqual(before);
  });

  it("prefers a canonical ELIZA_STATE_DIR over the branded alias", () => {
    process.env.ELIZA_STATE_DIR = "/var/eliza/state";
    process.env.MILADY_STATE_DIR = "/var/milady/state";
    expect(elizaModelsDir()).toBe(
      path.join("/var/eliza/state", "local-inference", "models"),
    );
  });

  it("resolves a branded MILADY_NAMESPACE for the homedir fallback", () => {
    process.env.MILADY_NAMESPACE = "brandns";
    expect(elizaModelsDir()).toBe(
      path.join(homedir(), ".brandns", "local-inference", "models"),
    );
  });

  it("treats an empty/whitespace value as unset (empty-is-unset)", () => {
    process.env.MILADY_STATE_DIR = "   ";
    process.env.ELIZA_STATE_DIR = "";
    expect(elizaModelsDir()).toBe(
      path.join(homedir(), ".eliza", "local-inference", "models"),
    );
  });

  it("a blank canonical ELIZA_STATE_DIR does not shadow a present branded alias", () => {
    process.env.ELIZA_STATE_DIR = "";
    process.env.MILADY_STATE_DIR = "/var/milady/state";
    expect(elizaModelsDir()).toBe(
      path.join("/var/milady/state", "local-inference", "models"),
    );
  });
});
