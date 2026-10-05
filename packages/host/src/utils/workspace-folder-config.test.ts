import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  clearWorkspaceFolderConfig,
  readWorkspaceFolderConfig,
  workspaceFolderConfigPath,
  writeWorkspaceFolderConfig,
} from "./workspace-folder-config.js";

const directories: string[] = [];
function environment() {
  const root = mkdtempSync(join(tmpdir(), "eliza-workspace-config-"));
  directories.push(root);
  return { ELIZA_STATE_DIR: root };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
it("round-trips and clears the complete selection", () => {
  const env = environment();
  expect(readWorkspaceFolderConfig(env)).toBeNull();
  const saved = writeWorkspaceFolderConfig(
    { path: "/workspace/🟠", bookmark: "complete bookmark" },
    env,
  );
  expect(readWorkspaceFolderConfig(env)).toEqual(saved);
  clearWorkspaceFolderConfig(env);
  clearWorkspaceFolderConfig(env);
  expect(readWorkspaceFolderConfig(env)).toBeNull();
});
it.each(["{", JSON.stringify({ path: 42, bookmark: null, updatedAt: "now" })])(
  "rejects corrupt selection instead of selecting an implicit workspace: %s",
  (value) => {
    const env = environment();
    writeFileSync(workspaceFolderConfigPath(env), value);
    expect(() => readWorkspaceFolderConfig(env)).toThrow(
      expect.objectContaining({ code: "WORKSPACE_FOLDER_CONFIG_INVALID" }),
    );
  },
);
