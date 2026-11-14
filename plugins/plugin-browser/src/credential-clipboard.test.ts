/** Exercises credential leases and provider failure isolation through real child processes. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.js";
import { leaseCredentialClipboard } from "./credential-clipboard.js";
import {
  clearPasswordManagerBackendCache,
  injectCredentialToClipboard,
} from "./password-manager-bridge.js";

const originalEnv = { ...process.env };
let directory: string;
let clipboardFile: string;

describe.skipIf(process.platform !== "linux")(
  "credential clipboard subprocess boundary",
  () => {
    beforeEach(async () => {
      const root = testOutputPath("credential-clipboard");
      await mkdir(root, { recursive: true });
      directory = await mkdtemp(path.join(root, "case-"));
      clipboardFile = path.join(directory, "clipboard");
      await writeFile(clipboardFile, "previous copy");
      const clipboard = `#!${process.execPath}
import fs from 'node:fs';
const file = process.env.TEST_CLIPBOARD_FILE;
if (process.argv.includes('-out') || process.argv.includes('--no-newline')) process.stdout.write(fs.readFileSync(file));
else { const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk)); process.stdin.on('end', () => fs.writeFileSync(file, Buffer.concat(chunks))); }
`;
      for (const name of ["xclip", "wl-copy", "wl-paste"]) {
        await writeFile(path.join(directory, name), clipboard, { mode: 0o700 });
      }
      process.env.PATH = `${directory}:${originalEnv.PATH}`;
      process.env.TEST_CLIPBOARD_FILE = clipboardFile;
      process.env.ELIZA_TEST_PASSWORD_MANAGER_BACKEND = "0";
      delete process.env.WAYLAND_DISPLAY;
      clearPasswordManagerBackendCache();
    });

    afterEach(async () => {
      process.env = { ...originalEnv };
      clearPasswordManagerBackendCache();
      await rm(directory, { recursive: true, force: true });
    });

    it("clears an owned credential and zeroes the consumed buffer", async () => {
      const secret = Buffer.from("lease-secret");
      const expire = await leaseCredentialClipboard(secret, 30_000);
      expect(await readFile(clipboardFile, "utf8")).toBe("lease-secret");
      await expire();
      expect(await readFile(clipboardFile, "utf8")).toBe("");
      expect(secret.every((byte) => byte === 0)).toBe(true);
      await expire();
    });

    it("preserves a newer copy when an earlier lease ends", async () => {
      const expire = await leaseCredentialClipboard(
        Buffer.from("lease-secret"),
        30_000,
      );
      await writeFile(clipboardFile, "new user copy");
      await expire();
      expect(await readFile(clipboardFile, "utf8")).toBe("new user copy");
    });

    it("expires a Wayland credential automatically", async () => {
      process.env.WAYLAND_DISPLAY = "test-wayland";
      const expire = await leaseCredentialClipboard(
        Buffer.from("lease-secret"),
        40,
      );
      try {
        await expect
          .poll(() => readFile(clipboardFile, "utf8"), { timeout: 3000 })
          .toBe("");
      } finally {
        await expire();
      }
    });

    it("does not write partial failed provider output or reveal it in an error", async () => {
      const op = path.join(directory, "op");
      await writeFile(
        op,
        `#!${process.execPath}
if (process.argv.includes('--version')) process.exit(0);
process.stdout.write('partial-secret'); process.stderr.write('secret-error'); process.exit(1);
`,
        { mode: 0o700 },
      );
      let failure: unknown;
      try {
        await injectCredentialToClipboard("item-id", "password", {
          preferredBackend: "1password",
          opPath: op,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain("secret");
      expect(JSON.stringify(failure)).not.toContain("secret");
      expect(await readFile(clipboardFile, "utf8")).toBe("previous copy");
    });
  },
);
