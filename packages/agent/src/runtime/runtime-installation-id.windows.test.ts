/** Exercises real Windows Credential Manager identity persistence, process concurrency and corrupt-store rejection. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateRuntimeInstallationId } from "./runtime-installation-id.ts";

const exec = promisify(execFile);
const roots: string[] = [];
const entries: Array<{ deletePassword(): void }> = [];
const require = createRequire(import.meta.url);
function credential(root: string) {
  const credentialRequire = createRequire(
    require.resolve("@elizaos/credentials/package.json"),
  );
  const { Entry } = credentialRequire("@napi-rs/keyring");
  const entry = new Entry(
    "eliza.runtime-installation-identity.v1",
    createHash("sha256").update(path.resolve(root)).digest("hex"),
  );
  entries.push(entry);
  return entry;
}
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-id-windows-"));
  roots.push(root);
  return root;
}
async function freshProcess(root: string) {
  const modulePath = path.join(
    import.meta.dirname,
    "runtime-installation-id.ts",
  );
  const script = `const {loadOrCreateRuntimeInstallationId}=await import(${JSON.stringify(modulePath)}); console.log(await loadOrCreateRuntimeInstallationId(${JSON.stringify(root)}));`;
  const result = await exec(
    "bun",
    ["--conditions=eliza-source", "--eval", script],
    { timeout: 60_000 },
  );
  return result.stdout.trim();
}
afterEach(async () => {
  for (const entry of entries.splice(0)) entry.deletePassword();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe.runIf(process.platform === "win32")(
  "Windows runtime installation identity",
  () => {
    it("converges across first-boot processes and persists across restart without a state-file identity", async () => {
      const root = await directory();
      credential(root);
      const identities = await Promise.all(
        Array.from({ length: 4 }, () => freshProcess(root)),
      );
      expect(new Set(identities).size).toBe(1);
      expect(identities[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(await loadOrCreateRuntimeInstallationId(root)).toBe(identities[0]);
      expect(await freshProcess(root)).toBe(identities[0]);
      expect(await fs.readdir(root)).toEqual([]);
      await fs.rm(root, { recursive: true });
      expect(await freshProcess(root)).toBe(identities[0]);
      const other = await directory();
      credential(other);
      expect(await freshProcess(other)).not.toBe(identities[0]);
    }, 120_000);

    it("rejects a malformed credential without replacing it or creating a plaintext fallback", async () => {
      const root = await directory();
      const entry = credential(root);
      entry.setPassword("not-a-valid-master-key");
      await expect(
        loadOrCreateRuntimeInstallationId(root),
      ).rejects.toMatchObject({
        code: "RUNTIME_INSTALLATION_ID_SECURE_STORAGE_UNAVAILABLE",
      });
      expect(entry.getPassword()).toBe("not-a-valid-master-key");
      expect(await fs.readdir(root)).toEqual([]);
    }, 60_000);

    it("fails closed when the native lock host is unavailable even for an existing credential", async () => {
      const root = await directory();
      const entry = credential(root);
      const identity = await loadOrCreateRuntimeInstallationId(root);
      const stored = entry.getPassword();
      const systemRoot = process.env.SystemRoot;
      try {
        process.env.SystemRoot = path.join(
          root,
          "missing-windows-installation",
        );
        await expect(
          loadOrCreateRuntimeInstallationId(root),
        ).rejects.toMatchObject({
          code: "RUNTIME_INSTALLATION_ID_SECURE_STORAGE_UNAVAILABLE",
        });
        expect(entry.getPassword()).toBe(stored);
      } finally {
        if (systemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = systemRoot;
      }
      expect(await loadOrCreateRuntimeInstallationId(root)).toBe(identity);
    }, 60_000);
  },
);
