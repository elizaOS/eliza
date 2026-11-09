/** Exercises the classic `pass` backend against a folder-organized password store. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.js";
import {
  clearPasswordManagerBackendCache,
  injectCredentialToClipboard,
  listPasswordItems,
  searchPasswordItems,
} from "./password-manager-bridge.js";

const originalEnv = { ...process.env };
const config = { preferredBackend: "protonpass" } as const;
let directory: string;
let copiedFile: string;

// Prints `ls` the way pass does (`tree -N -C`: NBSP padding, folders colored
// under LS_COLORS); `show --clip=1 <path>` only succeeds for a real entry.
const pass = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const store = process.env.PASSWORD_STORE_DIR;
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
function walk(dir, prefix) {
  const names = fs.readdirSync(dir).sort();
  names.forEach((name, index) => {
    const last = index === names.length - 1;
    const full = path.join(dir, name);
    const folder = fs.statSync(full).isDirectory();
    const label = folder ? '\\u001b[01;34m' + name + '\\u001b[0m' : name.replace(/\\.gpg$/, '');
    process.stdout.write(prefix + (last ? '\\u2514\\u2500\\u2500 ' : '\\u251c\\u2500\\u2500 ') + label + '\\n');
    if (folder) walk(full, prefix + (last ? '    ' : '\\u2502\\u00a0\\u00a0 '));
  });
}
if (args[0] === 'ls') {
  process.stdout.write('Password Store\\n');
  walk(store, '');
  process.exit(0);
}
if (args[0] === 'show' && fs.existsSync(path.join(store, args.at(-1) + '.gpg'))) {
  fs.writeFileSync(process.env.TEST_PASS_COPIED_FILE, args.at(-1));
  process.exit(0);
}
process.exit(1);
`;

describe.skipIf(process.platform === "win32")(
  "pass backend with a folder-organized store",
  () => {
    beforeEach(async () => {
      const root = testOutputPath("password-manager-bridge");
      await mkdir(root, { recursive: true });
      directory = await mkdtemp(path.join(root, "case-"));
      const store = path.join(directory, "store");
      copiedFile = path.join(directory, "copied");
      await mkdir(path.join(store, "Email", "work"), { recursive: true });
      await writeFile(path.join(store, "Email", "gmail.com.gpg"), "");
      await writeFile(path.join(store, "Email", "work", "example.com.gpg"), "");
      await writeFile(path.join(store, "github.com.gpg"), "");
      await writeFile(copiedFile, "");
      await writeFile(path.join(directory, "pass"), pass, { mode: 0o700 });
      process.env.PATH = `${directory}:${originalEnv.PATH}`;
      process.env.PASSWORD_STORE_DIR = store;
      process.env.TEST_PASS_COPIED_FILE = copiedFile;
      process.env.ELIZA_TEST_PASSWORD_MANAGER_BACKEND = "0";
      clearPasswordManagerBackendCache();
    });

    afterEach(async () => {
      process.env = { ...originalEnv };
      clearPasswordManagerBackendCache();
      await rm(directory, { recursive: true, force: true });
    });

    it("lists each entry by its store path and skips folder rows", async () => {
      const items = await listPasswordItems({}, config);
      expect(items.map((item) => item.id)).toEqual([
        "Email/gmail.com",
        "Email/work/example.com",
        "github.com",
      ]);
    });

    it("copies the nested entry a search returned", async () => {
      const [item] = await searchPasswordItems("gmail", config);
      await injectCredentialToClipboard(item.id, "password", config);
      expect(await readFile(copiedFile, "utf8")).toBe("Email/gmail.com");
    });
  },
);
