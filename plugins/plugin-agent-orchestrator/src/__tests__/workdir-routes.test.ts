import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolvePinnedAdapter,
  resolveWorkdirRoute,
} from "../actions/coding-task-helpers.js";

const ENV_KEY = "TASK_AGENT_WORKDIR_ROUTES";

let tmpRoot: string;
let appsDir: string;
let originalValue: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workdir-routes-"));
  appsDir = path.join(tmpRoot, "static-apps");
  fs.mkdirSync(appsDir, { recursive: true });
  originalValue = process.env[ENV_KEY];
});

afterEach(() => {
  if (originalValue === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalValue;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveWorkdirRoute", () => {
  it("matches a route when matchAll/matchAny terms appear and excludes don't", () => {
    process.env[ENV_KEY] = JSON.stringify([
      {
        id: "static-apps",
        workdir: appsDir,
        matchAll: ["app"],
        matchAny: ["build", "make"],
        excludeAny: ["production"],
        instructions: "Write under data/apps/<slug>/.",
      },
    ]);

    const result = resolveWorkdirRoute(
      undefined,
      "build me a stopwatch app",
      "@bot build me a stopwatch app on your site",
    );

    expect(result?.id).toBe("static-apps");
    expect(result?.workdir).toBe(appsDir);
    expect(result?.instructions).toContain("data/apps");
  });

  it("returns undefined when an excludeAny term is present", () => {
    process.env[ENV_KEY] = JSON.stringify([
      {
        id: "static-apps",
        workdir: appsDir,
        matchAll: ["app"],
        matchAny: ["build"],
        excludeAny: ["production"],
      },
    ]);

    const result = resolveWorkdirRoute(
      undefined,
      "build a production app",
      "build a production app",
    );

    expect(result).toBeUndefined();
  });

  it("skips a matching route whose workdir does not exist", () => {
    const missing = path.join(tmpRoot, "does-not-exist");
    process.env[ENV_KEY] = JSON.stringify([
      {
        id: "missing-route",
        workdir: missing,
        matchAny: ["build"],
      },
    ]);

    const result = resolveWorkdirRoute(
      undefined,
      "build something",
      "build something",
    );

    expect(result).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    process.env[ENV_KEY] = "{not json";
    const result = resolveWorkdirRoute(undefined, "build app", "build app");
    expect(result).toBeUndefined();
  });

  it("returns the first matching route when multiple match", () => {
    const second = path.join(tmpRoot, "second");
    fs.mkdirSync(second, { recursive: true });
    process.env[ENV_KEY] = JSON.stringify([
      { id: "first", workdir: appsDir, matchAny: ["build"] },
      { id: "second", workdir: second, matchAny: ["build"] },
    ]);

    const result = resolveWorkdirRoute(
      undefined,
      "build something",
      "build something",
    );

    expect(result?.id).toBe("first");
  });

  it("does not false-positive on substrings: 'preview' must not match excludeAny 'pr'", () => {
    process.env[ENV_KEY] = JSON.stringify([
      {
        id: "static-apps",
        workdir: appsDir,
        matchAll: ["app"],
        matchAny: ["build"],
        excludeAny: ["pr", "ai"],
      },
    ]);

    // Realistic phrasing where "pr" appears inside "preview" and "ai"
    // inside "plain" — pure substring match would block the route.
    const result = resolveWorkdirRoute(
      undefined,
      "Build a tip calculator app using plain JS with a live preview URL.",
      "build a tip calculator app",
    );

    expect(result?.id).toBe("static-apps");
  });

  it("matches against userRequest even when the sub-task drops the keyword", () => {
    process.env[ENV_KEY] = JSON.stringify([
      {
        id: "static-apps",
        workdir: appsDir,
        matchAll: ["app"],
        matchAny: ["build"],
      },
    ]);

    // sub-task split that lost "app" from the original phrasing
    const result = resolveWorkdirRoute(
      undefined,
      "create a stopwatch with start/stop/lap",
      "build me a stopwatch app",
    );

    expect(result?.id).toBe("static-apps");
  });
});

describe("resolvePinnedAdapter", () => {
  const KEYS = [
    "PARALLAX_DEFAULT_AGENT_TYPE",
    "PARALLAX_AGENT_SELECTION_STRATEGY",
  ];
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("returns undefined when no default is configured", () => {
    expect(resolvePinnedAdapter(undefined)).toBeUndefined();
  });

  it("returns the configured adapter when default + fixed strategy", () => {
    process.env.PARALLAX_DEFAULT_AGENT_TYPE = "opencode";
    expect(resolvePinnedAdapter(undefined)).toBe("opencode");
  });

  it("defaults to fixed strategy when the env var is unset", () => {
    process.env.PARALLAX_DEFAULT_AGENT_TYPE = "claude";
    expect(resolvePinnedAdapter(undefined)).toBe("claude");
  });

  it("returns undefined when strategy is non-fixed", () => {
    process.env.PARALLAX_DEFAULT_AGENT_TYPE = "opencode";
    process.env.PARALLAX_AGENT_SELECTION_STRATEGY = "ranked";
    expect(resolvePinnedAdapter(undefined)).toBeUndefined();
  });

  it("returns undefined for unrecognised adapter names", () => {
    process.env.PARALLAX_DEFAULT_AGENT_TYPE = "not-an-adapter";
    expect(resolvePinnedAdapter(undefined)).toBeUndefined();
  });

  it("normalises case", () => {
    process.env.PARALLAX_DEFAULT_AGENT_TYPE = "OPENCODE";
    expect(resolvePinnedAdapter(undefined)).toBe("opencode");
  });
});
