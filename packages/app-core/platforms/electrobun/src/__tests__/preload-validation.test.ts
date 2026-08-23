import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: (...a: unknown[]) => mocks.existsSync(...a),
    readFileSync: (...a: unknown[]) => mocks.readFileSync(...a),
    statSync: (...a: unknown[]) => mocks.statSync(...a),
  },
}));

import {
  getElectrobunPreloadStatus,
  readBuiltPreloadScript,
} from "../preload-validation.ts";

const fakeFs = {
  existsSync: (p: string) => mocks.existsSync(p),
  readFileSync: (p: string, enc: string) => mocks.readFileSync(p, enc),
  statSync: (p: string) => mocks.statSync(p),
} as never;

describe("getElectrobunPreloadStatus", () => {
  it("reports stale when the source is newer than preload", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockImplementation((p: string) =>
      p.includes("preload.js") ? { mtimeMs: 100 } : { mtimeMs: 200 },
    );
    const status = getElectrobunPreloadStatus("/app", fakeFs);
    expect(status.preloadExists).toBe(true);
    expect(status.sourceExists).toBe(true);
    expect(status.stale).toBe(true);
  });

  it("reports not stale when preload is newer", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockImplementation((p: string) =>
      p.includes("preload.js") ? { mtimeMs: 300 } : { mtimeMs: 200 },
    );
    expect(getElectrobunPreloadStatus("/app", fakeFs).stale).toBe(false);
  });

  it("reports missing pieces without throwing", () => {
    mocks.existsSync.mockReturnValue(false);
    const status = getElectrobunPreloadStatus("/app", fakeFs);
    expect(status.preloadExists).toBe(false);
    expect(status.stale).toBe(false);
  });
});

describe("readBuiltPreloadScript", () => {
  it("throws when preload is missing", () => {
    mocks.existsSync.mockReturnValue(false);
    expect(() => readBuiltPreloadScript("/app", fakeFs)).toThrow(
      "preload.js is missing",
    );
  });

  it("throws when preload is stale", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockImplementation((p: string) =>
      p.includes("preload.js") ? { mtimeMs: 100 } : { mtimeMs: 200 },
    );
    expect(() => readBuiltPreloadScript("/app", fakeFs)).toThrow("stale");
  });

  it("throws when preload is empty", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockReturnValue({ mtimeMs: 300 });
    mocks.readFileSync.mockReturnValue("   ");
    expect(() => readBuiltPreloadScript("/app", fakeFs)).toThrow("empty");
  });

  it("returns the preload content when valid", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockReturnValue({ mtimeMs: 300 });
    mocks.readFileSync.mockReturnValue("// preload");
    expect(readBuiltPreloadScript("/app", fakeFs)).toBe("// preload");
  });
});
