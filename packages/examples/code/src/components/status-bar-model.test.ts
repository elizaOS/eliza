// @vitest-environment node
//
// #11294: the status bar surfaces the active model/provider ("which model am I
// talking to") at full width, elided sanely, omitted when unconfigured, and
// never overflowing / crashing. Drives the real StatusBar.render with env-driven
// model config.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@elizaos/tui";
import chalk from "chalk";
import { useStore } from "../lib/store.js";
import { StatusBar } from "./StatusBar.js";

const MODEL_ENV_KEYS = [
  "ELIZA_CODE_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_LARGE_MODEL",
  "OPENAI_MODEL",
  "OPENAI_SMALL_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_LARGE_MODEL",
] as const;

const saved: Record<string, string | undefined> = {};
const prevChalk = chalk.level;

beforeEach(() => {
  chalk.level = 0; // deterministic plain text
  for (const k of MODEL_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Isolate room state per test (some cases set a max-length room name).
  useStore.setState({ rooms: [] });
  const room = useStore.getState().createRoom("Main");
  useStore.getState().switchRoom(room.id);
});

afterEach(() => {
  chalk.level = prevChalk;
  for (const k of MODEL_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("status bar model indicator (#11294)", () => {
  test("shows the configured model name at full width", () => {
    process.env.ELIZA_CODE_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_LARGE_MODEL = "llama-3.3-70b";

    const lines = new StatusBar().render(100);
    const joined = lines.join("\n");
    expect(joined).toContain("llama-3.3-70b");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(100);
  });

  test("falls back to the bare provider when no model name is set", () => {
    process.env.ELIZA_CODE_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant";

    const joined = new StatusBar().render(100).join("\n");
    expect(joined).toContain("anthropic");
  });

  test("elides an overlong model name", () => {
    process.env.ELIZA_CODE_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_LARGE_MODEL =
      "some-absurdly-long-model-identifier-that-exceeds-the-cap";

    const joined = new StatusBar().render(120).join("\n");
    expect(joined).toContain("…"); // elided
    expect(joined).not.toContain("exceeds-the-cap");
  });

  test("never overflows with a max-length room name + long cwd (50/80/100/120)", () => {
    process.env.ELIZA_CODE_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    // Elides to the 22-char cap — the widest the indicator can get.
    process.env.OPENAI_LARGE_MODEL =
      "some-absurdly-long-model-identifier-that-exceeds-the-cap";

    useStore.setState({ rooms: [] });
    const room = useStore.getState().createRoom("a".repeat(20));
    useStore.getState().switchRoom(room.id);

    const bar = new StatusBar();
    // Pin a long cwd (the ctor already stamped lastCwdCheck, so render()
    // won't refresh it away within this test).
    (bar as unknown as { cwd: string }).cwd =
      `/Users/someone/${"deeply/nested/".repeat(4)}project`;

    for (const width of [50, 80, 100, 120] as const) {
      for (const l of bar.render(width)) {
        expect(visibleWidth(l)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("omits the model at narrow width and never crashes unconfigured", () => {
    // No provider env at all → describeActiveModel returns null.
    const narrow = new StatusBar().render(50);
    expect(narrow.length).toBeGreaterThan(0);
    for (const l of narrow) expect(visibleWidth(l)).toBeLessThanOrEqual(50);

    // Even at full width with no keys, it renders (no model, no throw).
    const full = new StatusBar().render(100);
    for (const l of full) expect(visibleWidth(l)).toBeLessThanOrEqual(100);
  });
});
