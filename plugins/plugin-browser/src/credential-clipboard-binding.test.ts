/** Real subprocess checks; every clipboard command resolves inside one owned temporary directory. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.js";
import { leaseCredentialClipboard } from "./credential-clipboard.js";

const execFileAsync = promisify(execFile);
const originalEnv = { ...process.env };
const directories: string[] = [];

async function clipboardFixture(initial: string) {
  const root = testOutputPath("credential-clipboard-binding");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "case-"));
  directories.push(directory);
  const file = path.join(directory, "clipboard");
  await writeFile(file, initial);
  const script = `#!${process.execPath}
import fs from 'node:fs';
const file = process.env.CLIPBOARD_BINDING_FILE;
const read = process.argv[1].endsWith('pbpaste') || process.argv[1].endsWith('wl-paste') || process.argv.includes('-out');
if (read) process.stdout.write(fs.readFileSync(file));
else { const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk)); process.stdin.on('end', () => fs.writeFileSync(file, Buffer.concat(chunks))); }
`;
  for (const name of ["pbcopy", "pbpaste", "xclip", "wl-copy", "wl-paste"]) {
    await writeFile(path.join(directory, name), script, { mode: 0o700 });
  }
  return { directory, file };
}

function select(fixture: { directory: string; file: string }) {
  process.env.PATH = fixture.directory;
  process.env.CLIPBOARD_BINDING_FILE = fixture.file;
  delete process.env.WAYLAND_DISPLAY;
}

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "credential clipboard admitted command binding",
  () => {
    it("expires through the original executable and environment after PATH changes", async () => {
      const first = await clipboardFixture("");
      const second = await clipboardFixture("later clipboard");
      select(first);
      const secret = Buffer.from("owned fixture value");
      const expire = await leaseCredentialClipboard(secret, 60_000);
      select(second);
      await expire();
      expect(await readFile(first.file, "utf8")).toBe("");
      expect(await readFile(second.file, "utf8")).toBe("later clipboard");
      expect(secret.every((byte) => byte === 0)).toBe(true);
    });

    it("does not fall back to a different executable when the admitted one disappears", async () => {
      const first = await clipboardFixture("");
      const second = await clipboardFixture("owned fixture value");
      select(first);
      const secret = Buffer.from("owned fixture value");
      const expire = await leaseCredentialClipboard(secret, 60_000);
      await rm(first.directory, { recursive: true, force: true });
      select(second);
      await expect(expire()).rejects.toMatchObject({
        code: "CREDENTIAL_CLIPBOARD_FAILED",
      });
      expect(await readFile(second.file, "utf8")).toBe("owned fixture value");
      expect(secret.every((byte) => byte === 0)).toBe(true);
    });

    it("uses the admitted executable and environment for process-exit cleanup", async () => {
      const first = await clipboardFixture("");
      const second = await clipboardFixture("later clipboard");
      const source = new URL("./credential-clipboard.ts", import.meta.url).href;
      const program = `
const { leaseCredentialClipboard } = await import(${JSON.stringify(source)});
await leaseCredentialClipboard(Buffer.from('owned fixture value'), 60000);
process.env.PATH = ${JSON.stringify(second.directory)};
process.env.CLIPBOARD_BINDING_FILE = ${JSON.stringify(second.file)};
process.exit(0);
`;
      await execFileAsync(
        process.execPath,
        [
          "--import=tsx",
          "--conditions=eliza-source",
          "--input-type=module",
          "-e",
          program,
        ],
        {
          cwd: new URL("../../../", import.meta.url),
          env: {
            ...originalEnv,
            PATH: first.directory,
            CLIPBOARD_BINDING_FILE: first.file,
            WAYLAND_DISPLAY: "",
          },
          timeout: 30_000,
        },
      );
      expect(await readFile(first.file, "utf8")).toBe("");
      expect(await readFile(second.file, "utf8")).toBe("later clipboard");
    });
  },
);
