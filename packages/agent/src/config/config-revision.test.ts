import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEffectiveElizaConfigSnapshot } from "./config.ts";
import { resetDevCloudEnvAuthorityForTests } from "./dev-cloud-env-authority.ts";

let stateDir: string;
let canonical: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-revision-"));
  canonical = path.join(stateDir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  vi.stubEnv("ELIZA_CONFIG_PATH", canonical);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", "");
  vi.stubEnv("ELIZA_NAMESPACE", "eliza");
  vi.stubEnv("ELIZA_DEV_SOURCE", "");
  vi.stubEnv("ELIZA_DEV_CLOUD_ENV_AUTHORITY", "");
  resetDevCloudEnvAuthorityForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetDevCloudEnvAuthorityForTests();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("effective config revisions", () => {
  it("tracks absence without inventing an empty revision for read errors", () => {
    const snapshot = loadEffectiveElizaConfigSnapshot();
    expect(snapshot.isCurrent()).toBe(true);
    fs.writeFileSync(canonical, '{"deploymentTarget":{"runtime":"cloud"}}');
    expect(snapshot.isCurrent()).toBe(false);
    const current = loadEffectiveElizaConfigSnapshot();
    const stat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((file, options) => {
      if (file === canonical) {
        throw Object.assign(new Error("test access denied"), {
          code: "EACCES",
        });
      }
      return stat(file, options);
    }) as typeof fs.statSync);
    expect(() => current.isCurrent()).toThrow("test access denied");
  });

  it("preserves complete included content and tracks overlay includes", () => {
    const included = path.join(stateDir, "included.json");
    const complete = "complete included content ".repeat(8_000);
    fs.writeFileSync(included, JSON.stringify({ custom: complete }));
    fs.writeFileSync(
      path.join(stateDir, "eliza.config-overlay.json"),
      JSON.stringify({ $include: "./included.json" }),
    );
    const snapshot = loadEffectiveElizaConfigSnapshot();
    expect((snapshot.config as Record<string, unknown>).custom).toBe(complete);
    fs.writeFileSync(included, JSON.stringify({ custom: `${complete} tail` }));
    expect(snapshot.isCurrent()).toBe(false);
  });

  it("tracks skills and config.env via their owning loader paths", () => {
    const first = loadEffectiveElizaConfigSnapshot();
    fs.writeFileSync(
      path.join(stateDir, "skills.json"),
      '{"extraDirs":["./one"]}',
    );
    expect(first.isCurrent()).toBe(false);
    const second = loadEffectiveElizaConfigSnapshot();
    fs.writeFileSync(
      path.join(stateDir, "config.env"),
      "# metadata-only fixture\n",
    );
    expect(second.isCurrent()).toBe(false);
  });

  it("rejects a config changed during the read rather than caching a mixed snapshot", () => {
    fs.writeFileSync(canonical, '{"deploymentTarget":{"runtime":"local"}}');
    const read = fs.readFileSync;
    let replaced = false;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, options) => {
      const result = read(file, options);
      if (file === canonical && !replaced) {
        replaced = true;
        fs.writeFileSync(
          canonical,
          '{"deploymentTarget":{"runtime":"remote"}}',
        );
      }
      return result;
    }) as typeof fs.readFileSync);
    expect(() => loadEffectiveElizaConfigSnapshot()).toThrowError(
      expect.objectContaining({ code: "CONFIG_SNAPSHOT_CHANGED_DURING_READ" }),
    );
    expect(
      loadEffectiveElizaConfigSnapshot().config.deploymentTarget?.runtime,
    ).toBe("remote");
  });

  it("includes launcher authority identity without retaining its credentials in revisions", () => {
    fs.writeFileSync(canonical, '{"deploymentTarget":{"runtime":"cloud"}}');
    const first = loadEffectiveElizaConfigSnapshot();
    vi.stubEnv("ELIZA_DEV_SOURCE", "1");
    vi.stubEnv("ELIZA_DEV_CLOUD_ENV_AUTHORITY", "offline");
    expect(first.isCurrent({ checkFiles: false })).toBe(false);
    expect(
      loadEffectiveElizaConfigSnapshot().config.deploymentTarget?.runtime,
    ).toBe("local");
  });
});
