import fs, { cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StewardSidecar } from "./steward-sidecar";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, cpSync: vi.fn(actual.cpSync) };
});

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "steward-state-upgrade-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("ELIZA_NAMESPACE", "eliza");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});
async function prepare(dir: string) {
  const sidecar = new StewardSidecar({ dataDir: dir });
  await (
    sidecar as unknown as { ensureDataDir(): Promise<void> }
  ).ensureDataDir();
}
it("copies existing Steward database bytes into an empty new state directory", async () => {
  const old = path.join(home, ".steward/data"),
    target = path.join(home, "new-state");
  fs.mkdirSync(old, { recursive: true });
  const bytes = Buffer.from([0, 255, 42, 13]);
  fs.writeFileSync(path.join(old, "wallet-data"), bytes);
  await prepare(target);
  expect(fs.readFileSync(path.join(target, "data/wallet-data"))).toEqual(bytes);
  expect(fs.readFileSync(path.join(old, "wallet-data"))).toEqual(bytes);
});
it("does not overwrite an existing destination database with legacy data", async () => {
  const old = path.join(home, ".steward/data"),
    target = path.join(home, "new-state");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "wallet-data"), "old");
  fs.mkdirSync(path.join(target, "data"), { recursive: true });
  fs.writeFileSync(path.join(target, "data/wallet-data"), "current");
  await prepare(target);
  expect(fs.readFileSync(path.join(target, "data/wallet-data"), "utf8")).toBe(
    "current",
  );
});

it("leaves no partial destination after a failed copy and can retry", async () => {
  const old = path.join(home, ".steward/data"),
    target = path.join(home, "new-state");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "wallet-data"), "original");
  const copy = vi
    .mocked(cpSync)
    .mockImplementationOnce((_source, destination) => {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(String(destination), "partial"), "incomplete");
      throw new Error("fixture copy failure");
    });
  await expect(prepare(target)).rejects.toThrow("fixture copy failure");
  expect(fs.existsSync(path.join(target, "data"))).toBe(false);
  expect(fs.readdirSync(target)).toEqual([]);
  expect(fs.readFileSync(path.join(old, "wallet-data"), "utf8")).toBe(
    "original",
  );
  copy.mockClear();
  await prepare(target);
  expect(fs.readFileSync(path.join(target, "data/wallet-data"), "utf8")).toBe(
    "original",
  );
});

it("does not adopt the original product database in another namespace", async () => {
  const old = path.join(home, ".steward/data"),
    target = path.join(home, "another-product");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "wallet-data"), "original");
  vi.stubEnv("ELIZA_NAMESPACE", "another-product");
  await prepare(target);
  expect(fs.readdirSync(path.join(target, "data"))).toEqual([]);
});
