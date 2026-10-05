import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectRegistryPath,
  readProjectRegistry,
} from "./utils/project-registry";

const roots: string[] = [];
function environment() {
  const root = mkdtempSync(join(tmpdir(), "eliza-project-registry-"));
  roots.push(root);
  return { ELIZA_STATE_DIR: root };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("project registry reads", () => {
  it("returns absence only for missing state", () => {
    expect(readProjectRegistry(environment())).toBeNull();
  });
  it.each([
    "{",
    '{"version":1,"projects":[]}',
    '{"version":2,"activeProjectId":null,"projects":[]}',
  ])("surfaces invalid persisted state: %s", (raw) => {
    const env = environment();
    writeFileSync(projectRegistryPath(env), raw);
    expect(() => readProjectRegistry(env)).toThrow(
      expect.objectContaining({ code: "PROJECT_REGISTRY_INVALID" }),
    );
  });
  it("does not disguise an unreadable registry as first-run absence", () => {
    const env = environment();
    mkdirSync(projectRegistryPath(env));
    expect(() => readProjectRegistry(env)).toThrow(
      expect.objectContaining({ code: "PROJECT_REGISTRY_READ_FAILED" }),
    );
  });
});
