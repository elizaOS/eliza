import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { writeJsonFileAtomic } from "./atomic-json-file.js";

it("publishes complete snapshots across concurrent processes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eliza-registry-atomic-"));
  const file = join(directory, "registry.json");
  try {
    writeJsonFileAtomic(file, {
      writer: "initial",
      payload: "initial".repeat(4096),
    });
    const implementation = new URL("./atomic-json-file.ts", import.meta.url)
      .href;
    let finished = false;
    const writers = ["one", "two"].map(
      (writer) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `import { writeJsonFileAtomic } from ${JSON.stringify(implementation)}; for (let i = 0; i < 40; i++) writeJsonFileAtomic(${JSON.stringify(file)}, { writer: ${JSON.stringify(writer)}, payload: ${JSON.stringify(writer)}.repeat(4096) });`,
            ],
            { stdio: ["ignore", "ignore", "pipe"] },
          );
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.once("error", reject);
          child.once("exit", (code, signal) =>
            code === 0
              ? resolve()
              : reject(
                  new Error(`Writer failed (${signal ?? code}): ${stderr}`),
                ),
          );
        }),
    );
    const writing = Promise.allSettled(writers).then((results) => {
      finished = true;
      return results;
    });
    try {
      do {
        const snapshot = JSON.parse(readFileSync(file, "utf8"));
        expect(["initial", "one", "two"]).toContain(snapshot.writer);
        expect(snapshot.payload).toBe(snapshot.writer.repeat(4096));
        await setImmediate();
      } while (!finished);
    } finally {
      await writing;
    }
    const results = await writing;
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Registry writers failed",
      );
    expect(readdirSync(directory)).toEqual(["registry.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

it("preserves an incompatible destination and removes only its own staging directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "eliza-registry-atomic-"));
  try {
    const target = join(directory, "registry.json");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "original");
    expect(() => writeJsonFileAtomic(target, { changed: true })).toThrow();
    expect(readFileSync(join(target, "keep"), "utf8")).toBe("original");
    expect(readdirSync(directory)).toEqual(["registry.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "preserves restrictive permissions when replacing a registry",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "eliza-registry-mode-"));
    try {
      const file = join(directory, "registry.json");
      writeFileSync(file, "{}", { mode: 0o600 });
      chmodSync(file, 0o600);
      writeJsonFileAtomic(file, { updated: true });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ updated: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a shared registry group-writable under the process umask",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "eliza-registry-shared-"));
    try {
      const file = join(directory, "registry.json");
      writeFileSync(file, "{}");
      chmodSync(file, 0o664);
      const implementation = new URL("./atomic-json-file.ts", import.meta.url)
        .href;
      // A child process owns its umask; worker threads cannot set one.
      const writer = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `process.umask(0o022); const { writeJsonFileAtomic } = await import(${JSON.stringify(implementation)}); writeJsonFileAtomic(${JSON.stringify(file)}, { updated: true });`,
        ],
        { encoding: "utf8" },
      );
      expect(writer.status, writer.stderr).toBe(0);
      expect(statSync(file).mode & 0o777).toBe(0o664);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ updated: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("publishes a create-only snapshot without replacing an existing writer", () => {
  const directory = mkdtempSync(join(tmpdir(), "eliza-registry-create-"));
  const file = join(directory, "registry.json");
  try {
    writeJsonFileAtomic(file, { owner: "first" }, { createOnly: true });
    expect(() =>
      writeJsonFileAtomic(file, { owner: "second" }, { createOnly: true }),
    ).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ owner: "first" });
    expect(readdirSync(directory)).toEqual(["registry.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
