/**
 * Exercises Baileys' real multi-file authentication adapter against a temporary
 * directory, proving credentials survive a process-style manager restart.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BaileysAuthManager } from "./auth";

const authDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    authDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("BaileysAuthManager real persistence", () => {
  it("persists and reloads credentials through the bundled Baileys adapter", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "eliza-whatsapp-auth-"));
    authDirectories.push(authDir);

    const firstManager = new BaileysAuthManager(authDir);
    const firstState = await firstManager.initialize();
    firstState.creds.registered = true;
    firstState.creds.me = { id: "14155552671:1@s.whatsapp.net", name: "Test Account" };
    await firstState.keys.set({
      "pre-key": {
        "1": {
          public: Buffer.from([1, 2, 3]),
          private: Buffer.from([4, 5, 6]),
        },
      },
    });
    await firstManager.save();

    const persisted = await readFile(path.join(authDir, "creds.json"), "utf8");
    expect(persisted).toContain("14155552671:1@s.whatsapp.net");
    expect((await stat(authDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(authDir, "creds.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(authDir, "pre-key-1.json"))).mode & 0o777).toBe(0o600);

    const secondManager = new BaileysAuthManager(authDir);
    const secondState = await secondManager.initialize();
    expect(secondState.creds.registered).toBe(true);
    expect(secondState.creds.me).toEqual({
      id: "14155552671:1@s.whatsapp.net",
      name: "Test Account",
    });
    expect(await secondState.keys.get("pre-key", ["1"])).toEqual({
      "1": {
        public: Buffer.from([1, 2, 3]),
        private: Buffer.from([4, 5, 6]),
      },
    });
  });

  it("repairs permissive existing directory and credential modes on reload", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "eliza-whatsapp-auth-"));
    authDirectories.push(authDir);
    await writeFile(path.join(authDir, "creds.json"), "{}");
    await chmod(authDir, 0o755);
    await chmod(path.join(authDir, "creds.json"), 0o644);

    await new BaileysAuthManager(authDir).initialize();

    expect((await stat(authDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(authDir, "creds.json"))).mode & 0o777).toBe(0o600);
  });

  it("repairs nested auth paths instead of leaving credential material permissive", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "eliza-whatsapp-auth-"));
    authDirectories.push(authDir);
    const nestedDir = path.join(authDir, "nested");
    await mkdir(nestedDir, { mode: 0o755 });
    await writeFile(path.join(nestedDir, "key.json"), "{}", { mode: 0o644 });

    await new BaileysAuthManager(authDir).initialize();

    expect((await stat(nestedDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(nestedDir, "key.json"))).mode & 0o777).toBe(0o600);
  });
});
