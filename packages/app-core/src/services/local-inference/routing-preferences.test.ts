import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readRoutingPreferences,
  setPolicy,
  setPreferredProvider,
  writeRoutingPreferences,
} from "./routing-preferences";

describe("routing preferences (real file I/O)", () => {
  let tmp: string;
  let origStateDir: string | undefined;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "milady-routing-prefs-"));
    origStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = tmp;
  });

  afterEach(async () => {
    if (origStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = origStateDir;
    }
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns empty prefs when no file exists yet", async () => {
    const prefs = await readRoutingPreferences();
    expect(prefs).toEqual({ preferredProvider: {}, policy: {} });
  });

  it("round-trips through writeRoutingPreferences", async () => {
    await writeRoutingPreferences({
      preferredProvider: { TEXT_LARGE: "anthropic" },
      policy: { TEXT_LARGE: "cheapest" },
    });
    const back = await readRoutingPreferences();
    expect(back.preferredProvider.TEXT_LARGE).toBe("anthropic");
    expect(back.policy.TEXT_LARGE).toBe("cheapest");
  });

  it("setPreferredProvider merges into existing state", async () => {
    await setPreferredProvider("TEXT_SMALL", "openai");
    const next = await setPreferredProvider("TEXT_LARGE", "anthropic");
    expect(next.preferredProvider).toEqual({
      TEXT_SMALL: "openai",
      TEXT_LARGE: "anthropic",
    });
  });

  it("setPreferredProvider(null) clears the slot", async () => {
    await setPreferredProvider("TEXT_SMALL", "openai");
    const cleared = await setPreferredProvider("TEXT_SMALL", null);
    expect(cleared.preferredProvider.TEXT_SMALL).toBeUndefined();
  });

  it("setPolicy stores policy without disturbing preferredProvider", async () => {
    await setPreferredProvider("TEXT_LARGE", "anthropic");
    const next = await setPolicy("TEXT_LARGE", "fastest");
    expect(next.preferredProvider.TEXT_LARGE).toBe("anthropic");
    expect(next.policy.TEXT_LARGE).toBe("fastest");
  });

  it("returns empty prefs on malformed file", async () => {
    await fs.mkdir(path.join(tmp, "local-inference"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, "local-inference", "routing.json"),
      "not json",
      "utf8",
    );
    const prefs = await readRoutingPreferences();
    expect(prefs).toEqual({ preferredProvider: {}, policy: {} });
  });

  it("ignores wrong-version files", async () => {
    await fs.mkdir(path.join(tmp, "local-inference"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, "local-inference", "routing.json"),
      JSON.stringify({ version: 2, preferences: {} }),
      "utf8",
    );
    const prefs = await readRoutingPreferences();
    expect(prefs).toEqual({ preferredProvider: {}, policy: {} });
  });
});
