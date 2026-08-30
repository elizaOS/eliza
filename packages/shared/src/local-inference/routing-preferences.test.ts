/**
 * Covers the routing-policy union and the real filesystem transaction used by
 * local inference. Persistence tests use isolated state directories and real
 * Bun child processes to exercise cross-process exclusion, stale recovery,
 * strict corruption handling, and atomic two-slot publication.
 */
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readRoutingPreferences,
  setTextRouting,
} from "./routing-preferences.js";

describe("routing preference persistence", () => {
  const previousStateDir = process.env.ELIZA_STATE_DIR;
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "routing-preferences-"));
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  });

  it("publishes both text slots as one routing state", async () => {
    const snapshots: Array<Awaited<ReturnType<typeof readRoutingPreferences>>> =
      [];
    const writes = Array.from({ length: 20 }, (_, index) =>
      setTextRouting(index % 2 === 0 ? "elizacloud" : "eliza-local-inference"),
    );
    let complete = false;
    const allWrites = Promise.all(writes).then((result) => {
      complete = true;
      return result;
    });
    while (!complete && snapshots.length < 100) {
      snapshots.push(await readRoutingPreferences());
    }
    await allWrites;

    for (const snapshot of snapshots) {
      const small = snapshot.preferredProvider.TEXT_SMALL;
      const large = snapshot.preferredProvider.TEXT_LARGE;
      expect(small === undefined || small === large).toBe(true);
      expect(snapshot.policy.TEXT_SMALL).toBe(snapshot.policy.TEXT_LARGE);
    }
  });

  it("rejects corrupt persisted state instead of replacing it", async () => {
    const root = path.join(stateDir, "local-inference");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "routing.json"), "{not-json", "utf8");

    await expect(setTextRouting("elizacloud")).rejects.toThrow(/not JSON/);
    await expect(readRoutingPreferences()).rejects.toThrow(/not JSON/);
  });

  it("recovers a stale lock owned by a dead local process", async () => {
    const root = path.join(stateDir, "local-inference");
    const lockPath = path.join(root, "routing.json.lock");
    await mkdir(root, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        id: "dead-owner",
        pid: 2_147_483_647,
        hostname: hostname(),
        createdAt: Date.now() - 120_000,
      }),
      "utf8",
    );
    const stale = new Date(Date.now() - 120_000);
    await utimes(lockPath, stale, stale);

    await expect(setTextRouting("elizacloud")).resolves.toMatchObject({
      preferredProvider: {
        TEXT_SMALL: "elizacloud",
        TEXT_LARGE: "elizacloud",
      },
    });
  });

  it("recovers a stale empty lock left before owner-token publication", async () => {
    const root = path.join(stateDir, "local-inference");
    const lockPath = path.join(root, "routing.json.lock");
    await mkdir(root, { recursive: true });
    await writeFile(lockPath, "", "utf8");
    const stale = new Date(Date.now() - 120_000);
    await utimes(lockPath, stale, stale);

    await expect(
      setTextRouting("eliza-local-inference"),
    ).resolves.toMatchObject({
      preferredProvider: {
        TEXT_SMALL: "eliza-local-inference",
        TEXT_LARGE: "eliza-local-inference",
      },
    });
  });

  it("preserves every update from synchronized child processes", async () => {
    const slots = [
      "TEXT_SMALL",
      "TEXT_LARGE",
      "TEXT_EMBEDDING",
      "TEXT_TO_SPEECH",
      "TRANSCRIPTION",
    ] as const;
    const barrierDir = path.join(stateDir, "barrier");
    const goPath = path.join(barrierDir, "go");
    await mkdir(barrierDir, { recursive: true });
    const moduleUrl = pathToFileURL(
      path.join(import.meta.dirname, "routing-preferences.ts"),
    ).href;

    const children = slots.map((slot, index) => {
      const readyPath = path.join(barrierDir, `ready-${index}`);
      const script = `
        import { existsSync, writeFileSync } from "node:fs";
        import { setPreferredProvider } from ${JSON.stringify(moduleUrl)};
        writeFileSync(${JSON.stringify(readyPath)}, "ready");
        while (!existsSync(${JSON.stringify(goPath)})) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        await setPreferredProvider(${JSON.stringify(slot)}, ${JSON.stringify(`provider-${index}`)});
      `;
      return spawn("bun", ["--conditions=eliza-source", "-e", script], {
        env: { ...process.env, ELIZA_STATE_DIR: stateDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
    });

    for (let attempt = 0; attempt < 500; attempt++) {
      const ready = await Promise.all(
        slots.map(async (_, index) => {
          try {
            await access(path.join(barrierDir, `ready-${index}`));
            return true;
          } catch {
            return false;
          }
        }),
      );
      if (ready.every(Boolean)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await writeFile(goPath, "go", "utf8");

    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            let stderr = "";
            child.stderr?.on("data", (chunk) => {
              stderr += String(chunk);
            });
            child.once("error", reject);
            child.once("exit", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`routing child exited ${code}: ${stderr}`));
            });
          }),
      ),
    );

    const preferences = await readRoutingPreferences();
    for (const [index, slot] of slots.entries()) {
      expect(preferences.preferredProvider[slot]).toBe(`provider-${index}`);
    }
  }, 20_000);
});
