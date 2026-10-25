/**
 * Protected-profile boot e2e. A separate OS process runs the real standalone
 * boot under `ELIZA_PROTECTED_PROFILE=dstack-cpu` without a pinned dstack
 * verifier: admission must reject before any boot phase, listener, config or
 * vault state exists. In this process the captured profile must refuse late
 * relaxation, evidence-factory registration and development key release. No
 * TEE hardware, verifier or KMS is simulated; the positive admission path
 * requires a real dstack CVM and is out of this harness's reach.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

// Captured once at first use; set before anything in this process reads it.
process.env.ELIZA_PROTECTED_PROFILE = "dstack-cpu";
process.env.ELIZA_TEE_PRODUCTION_PROFILE = "dstack-cpu";
delete process.env.ELIZA_DSTACK_EVIDENCE_CONFIG_JSON;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "fixtures", "protected-profile-boot-child.ts");
const directories: string[] = [];
let startApiServer: typeof import("../src/api/server.ts")["startApiServer"];
// Loading the API server graph is slow on a cold transform cache; keep it out
// of the per-scenario budget. Importing it captures nothing.
beforeAll(async () => {
  ({ startApiServer } = await import("../src/api/server.ts"));
}, 600_000);
afterAll(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("No port");
  return address.port;
}

function connects(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function runChild(env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string }>(
    (resolve, reject) => {
      const child = spawn("bun", ["--conditions=eliza-source", CHILD], {
        cwd: path.join(HERE, ".."),
        env: { ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal", ...env },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`protected boot child timed out\n${stderr}`));
      }, 100_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout });
      });
    },
  );
}

it("rejects boot before any phase, listener, config or vault state exists", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "protected-boot-"));
  directories.push(stateDirectory);
  const port = await freePort();
  const result = await runChild({
    ELIZA_STATE_DIR: stateDirectory,
    ELIZA_CONFIG_PATH: path.join(stateDirectory, "eliza.json"),
    ELIZA_PORT: String(port),
    ELIZA_PROTECTED_PROFILE: "dstack-cpu",
    ELIZA_TEE_PRODUCTION_PROFILE: "dstack-cpu",
  });
  expect(result.status).toBe(1);
  const line = result.stdout
    .split("\n")
    .find((entry) => entry.startsWith("PROTECTED_RESULT="));
  expect(JSON.parse(line?.slice("PROTECTED_RESULT=".length) ?? "{}")).toEqual({
    booted: false,
    code: "PROTECTED_PROFILE_ADMISSION_REJECTED",
    phases: [],
  });
  expect(await connects(port)).toBe(false);
  expect(await readdir(stateDirectory)).toEqual([]);
}, 120_000);

it("keeps the entry capture when the environment is relaxed afterwards", async () => {
  const { isProtectedProfileSelected, protectedTeeEnvironment } = await import(
    "../src/security/protected-profile.ts"
  );
  expect(isProtectedProfileSelected()).toBe(true);
  delete process.env.ELIZA_PROTECTED_PROFILE;
  process.env.ELIZA_TEE_PRODUCTION_PROFILE = "true";
  expect(isProtectedProfileSelected()).toBe(true);
  expect(protectedTeeEnvironment().ELIZA_TEE_PRODUCTION_PROFILE).toBe(
    "dstack-cpu",
  );
  const port = await freePort();
  await expect(
    startApiServer({ port, skipDeferredStartupWork: true }),
  ).rejects.toMatchObject({ code: "PROTECTED_PROFILE_ADMISSION_REJECTED" });
  expect(await connects(port)).toBe(false);
}, 120_000);

it("refuses evidence-factory registration and development key release", async () => {
  const {
    clearTeeEvidenceProviderFactory,
    registerTeeEvidenceProviderFactory,
    resolveTeeEvidenceProvider,
  } = await import("../src/services/tee-evidence-provider.ts");
  const { HttpTeeKeyReleaseClient, LocalTeeKeyReleaseClient } = await import(
    "../src/services/tee-key-release.ts"
  );
  const { unsealStateVolumeKey } = await import(
    "../src/services/tee-sealed-volume.ts"
  );
  const { prepareConfidentialModelWeights } = await import(
    "../src/services/tee-model-key-boot.ts"
  );
  const { protectedTeeEnvironment } = await import(
    "../src/security/protected-profile.ts"
  );

  const collected: string[] = [];
  const unpinned = {
    id: "unpinned-normalized-evidence",
    async collectEvidence() {
      collected.push("collected");
      return {
        kind: "tdx" as const,
        provider: "dstack",
        claims: { debugDisabled: true },
      };
    },
  };
  expect(() => registerTeeEvidenceProviderFactory(() => unpinned)).toThrow(
    expect.objectContaining({ code: "TEE_PROTECTED_PROFILE_FACTORY_REJECTED" }),
  );
  expect(() => clearTeeEvidenceProviderFactory()).toThrow(
    expect.objectContaining({ code: "TEE_PROTECTED_PROFILE_FACTORY_REJECTED" }),
  );
  expect(
    resolveTeeEvidenceProvider({ env: protectedTeeEnvironment() }),
  ).toBeUndefined();

  const digest = `sha256:${"a".repeat(64)}`;
  const policy = {
    required: true,
    requiredMeasurements: { agent: digest, policy: digest, device: digest },
  };
  const clients = [
    new LocalTeeKeyReleaseClient({ evidenceProvider: unpinned }),
    new HttpTeeKeyReleaseClient({
      baseUrl: "https://kms.example.invalid",
      evidenceProvider: unpinned,
      requireSecureTransport: true,
    }),
  ];
  for (const keyReleaseClient of clients) {
    await expect(
      unsealStateVolumeKey({ keyReleaseClient, policy }),
    ).rejects.toMatchObject({ code: "PROTECTED_PROFILE_KEY_RELEASE_REJECTED" });
    await expect(
      prepareConfidentialModelWeights({
        keyReleaseClient,
        policy,
        sealedWeights: {
          algorithm: "aes-256-gcm",
          ivBase64: "",
          authTagBase64: "",
          ciphertextBase64: "",
          weightsSha256: "a".repeat(64),
        },
        requiredMeasurements: [],
        env: { ELIZA_CONFIDENTIAL_WEIGHTS: "1" },
      }),
    ).rejects.toMatchObject({ code: "PROTECTED_PROFILE_KEY_RELEASE_REJECTED" });
  }
  expect(collected).toEqual([]);
});
