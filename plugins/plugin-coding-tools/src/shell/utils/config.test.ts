import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadShellConfig } from "./config";

describe("loadShellConfig SHELL_ALLOWED_DIRECTORY", () => {
  const previous = process.env.SHELL_ALLOWED_DIRECTORY;
  let homeDir = "";

  afterEach(() => {
    if (previous === undefined) delete process.env.SHELL_ALLOWED_DIRECTORY;
    else process.env.SHELL_ALLOWED_DIRECTORY = previous;
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    homeDir = "";
  });

  it("expands a home-relative allowed directory instead of reporting it missing", () => {
    homeDir = mkdtempSync(path.join(homedir(), ".eliza-shell-home-"));

    for (const configured of [
      `~/${path.basename(homeDir)}`,
      `$HOME/${path.basename(homeDir)}`,
    ]) {
      process.env.SHELL_ALLOWED_DIRECTORY = configured;
      // The directory exists. A literal home token resolves against the
      // process cwd instead, so the shell tool refuses to start with
      // SHELL_CONFIG_DIRECTORY_MISSING and no shell command can run.
      const config = loadShellConfig();
      expect(realpathSync(config.allowedDirectory)).toBe(realpathSync(homeDir));
    }
  });
});
