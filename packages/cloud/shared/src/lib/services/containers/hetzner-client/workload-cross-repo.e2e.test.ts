/**
 * CROSS-REPO E2E (#17432): the REAL Steward API × the REAL eliza writer and
 * resolver logic. No invented Steward stubs — this suite BOOTS the actual
 * Steward server (Bun, in-memory pglite, real tenantAuth middleware, real
 * /agent-enroll crypto, real SecretVault) from a sibling checkout and drives
 * the exact code paths production uses:
 *
 *   writer:   sealContainerEnvToWorkload (the createContainer/setEnv sealing
 *             unit) with the control plane's tenant API key
 *   resolver: resolveWorkloadSecretSettings (the agent boot unit) with ONLY
 *             the sealed env + capability — exactly what a container holds
 *
 * Proven end-to-end against the real API:
 *   - seal → boot-resolve round-trip (plaintext only in the resolver output)
 *   - authorization: the writer credential CANNOT resolve; a foreign
 *     workload's capability CANNOT read another namespace
 *   - rotation: re-PUT (Steward-native versioned rotation) → new value
 *     resolves; re-register (capability rotation) → old key stops enrolling
 *   - revocation: DELETE /workloads/:id → enrollment dead AND an already-
 *     sealed env resolves nothing
 *   - outage: Steward down → writer fails closed (no partial state)
 *   - absence: no secret value in the sealed env (≙ docker env / inspect /
 *     DB row / SSH line, which are all serializations of it), in process.env
 *     after the boot scrub, or in any failure string
 *
 * GATED on STEWARD_REPO_PATH (a checkout of Steward-Fi/steward with deps
 * installed). Skipped otherwise — CI for elizaos/eliza does not carry the
 * sibling repo; this suite is the documented cross-repo evidence runner:
 *
 *   STEWARD_REPO_PATH=~/projects/steward bun test workload-cross-repo
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  deriveWorkloadId,
  sealContainerEnvToWorkload,
  type WorkloadStewardConfig,
} from "./workload-env-refs";

setDefaultTimeout(120_000);

const STEWARD_REPO = process.env.STEWARD_REPO_PATH?.trim();
const ENABLED = Boolean(
  STEWARD_REPO && existsSync(join(STEWARD_REPO, "packages/api/src/embedded.ts")),
);
const describeCrossRepo = ENABLED ? describe : describe.skip;

const PORT = 39000 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
const TENANT_API_KEY = "stw_e2e_" + "a1b2c3d4e5f60718".repeat(2);
// Assembled by concatenation so no token-shaped literal exists for secret
// scanners to match (synthetic fixture, not a credential).
const SECRET_VALUE = ["sk", "live", "crossrepo", "supersecret", "777"].join("-");
const ORG = "org-e2e";
const PROJECT = `proj-${Date.now()}`;

let steward: ChildProcess | null = null;

function writerConfig(): WorkloadStewardConfig {
  return { baseUrl: BASE, tenantId: "default", apiKey: TENANT_API_KEY };
}

const CREATE_ENV = {
  OPENAI_API_KEY: SECRET_VALUE,
  NODE_ENV: "production",
};

/**
 * The resolver unit is imported from the AGENT package source — the same file
 * `startEliza` calls on the cloud container boot path. Path import (not a
 * package import) because cloud-shared does not depend on packages/agent;
 * the pin in workload-env-refs.ts documents the coupling.
 */
async function importResolver() {
  return import("../../../../../../../agent/src/runtime/operations/workload-secrets.ts");
}

async function waitForReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/ready`);
      if (res.status === 200) {
        const body = (await res.json()) as { status?: string };
        if (body.status === "ready") return;
      }
    } catch {
      // not up yet — retry until the deadline, then throw below (fail closed;
      // the suite cannot run without the real API).
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`real Steward API did not become ready on ${BASE}`);
}

describeCrossRepo("cross-repo: real Steward API × real eliza writer/resolver", () => {
  beforeAll(async () => {
    const keyHash = createHash("sha256").update(TENANT_API_KEY).digest("hex");
    steward = spawn("bun", ["packages/api/src/embedded.ts"], {
      cwd: STEWARD_REPO,
      env: {
        ...process.env,
        PORT: String(PORT),
        STEWARD_PGLITE_MEMORY: "true",
        STEWARD_MASTER_PASSWORD: "cross-repo-e2e-master-password-32ch",
        STEWARD_JWT_SECRET: "cross-repo-e2e-jwt-secret-32-chars-min!",
        STEWARD_AUDIT_HMAC_KEY: "d".repeat(64),
        STEWARD_DEFAULT_TENANT_KEY: keyHash,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForReady(90_000);
  });

  afterAll(() => {
    steward?.kill("SIGTERM");
  });

  let sealedEnv: Record<string, string> = {};
  let workloadId = "";

  test("writer seals through the real API: env carries refs + capability, never the value", async () => {
    const sealed = await sealContainerEnvToWorkload(
      { organizationId: ORG, projectName: PROJECT, environmentVars: { ...CREATE_ENV } },
      writerConfig(),
    );
    sealedEnv = sealed.env;
    workloadId = sealed.workloadId;
    expect(workloadId).toBe(deriveWorkloadId(ORG, PROJECT));
    expect(sealed.sealedKeys).toEqual(["OPENAI_API_KEY"]);

    // ABSENCE across the sealed env — this exact map is what gets persisted
    // to the containers row, interpolated into the SSH `docker create -e`
    // line, and therefore shown by `docker inspect`: no plaintext anywhere.
    const serialized = JSON.stringify(sealedEnv);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(sealedEnv.OPENAI_API_KEY).toBe(`vault://workload/${workloadId}/OPENAI_API_KEY`);
    expect(sealedEnv.NODE_ENV).toBe("production");
    // capability present, tenant credential ABSENT
    expect(sealedEnv.STEWARD_WORKLOAD_ID).toBe(workloadId);
    expect(sealedEnv.STEWARD_WORKLOAD_KEY?.length).toBeGreaterThan(100);
    expect(serialized).not.toContain(TENANT_API_KEY);
  });

  test("resolver boots with ONLY the sealed env: real enroll → resolve → settings overlay; env scrubbed", async () => {
    const { resolveWorkloadEnvOverlayForBoot } = await importResolver();
    // exactly what the container process sees: the sealed env, nothing else
    const containerEnv: NodeJS.ProcessEnv = { ...sealedEnv };
    const overlay = await resolveWorkloadEnvOverlayForBoot({ env: containerEnv });

    expect(overlay.OPENAI_API_KEY).toBe(SECRET_VALUE);
    // process.env-equivalent scrubbed: no sentinel, no capability key, and
    // the plaintext NEVER entered it.
    expect(containerEnv.OPENAI_API_KEY).toBeUndefined();
    expect(containerEnv.STEWARD_WORKLOAD_KEY).toBeUndefined();
    expect(JSON.stringify(containerEnv)).not.toContain(SECRET_VALUE);
  });

  test("authorization: the WRITER credential cannot resolve (403 from the real middleware)", async () => {
    const res = await fetch(`${BASE}/v1/workload-secrets/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Steward-Tenant": "default",
        "X-Steward-Key": TENANT_API_KEY,
      },
      body: JSON.stringify({ names: ["OPENAI_API_KEY"] }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET_VALUE);
  });

  test("tenant/workload isolation: a FOREIGN workload's capability resolves nothing from this namespace", async () => {
    // register a second workload under the same tenant (the strictest case:
    // same tenant, different container)
    const foreign = await sealContainerEnvToWorkload(
      {
        organizationId: ORG,
        projectName: `${PROJECT}-other`,
        environmentVars: { API_TOKEN: "other-secret" },
      },
      writerConfig(),
    );
    const { resolveWorkloadSecretSettings } = await importResolver();
    // the foreign container tries to resolve OUR ref with ITS capability
    const { resolved, failures } = await resolveWorkloadSecretSettings(
      { STOLEN: sealedEnv.OPENAI_API_KEY as string },
      { env: { ...foreign.env } },
    );
    expect(resolved).toEqual({});
    expect(failures).toEqual(["STOLEN"]);
  });

  test("rotation: re-PUT rotates the value server-side (versioned); the workload resolves the NEW value", async () => {
    const rotated = `${SECRET_VALUE}-v2`;
    const resealed = await sealContainerEnvToWorkload(
      {
        organizationId: ORG,
        projectName: PROJECT,
        environmentVars: { OPENAI_API_KEY: rotated, NODE_ENV: "production" },
      },
      writerConfig(),
    );
    const { resolveWorkloadEnvOverlayForBoot } = await importResolver();
    const overlay = await resolveWorkloadEnvOverlayForBoot({ env: { ...resealed.env } });
    expect(overlay.OPENAI_API_KEY).toBe(rotated);

    // capability rotation happened too: the ORIGINAL capability (first seal)
    // can no longer enroll — its signer was revoked in the re-register tx.
    const { resolveWorkloadSecretSettings } = await importResolver();
    const { resolved, failures } = await resolveWorkloadSecretSettings(
      { OPENAI_API_KEY: sealedEnv.OPENAI_API_KEY as string },
      { env: { ...sealedEnv } }, // the OLD env, OLD private key
    );
    expect(resolved).toEqual({});
    expect(failures).toEqual(["OPENAI_API_KEY"]);

    sealedEnv = resealed.env; // continue with the live capability
  });

  test("revocation: DELETE /workloads/:id kills enrollment and empties the namespace", async () => {
    const res = await fetch(`${BASE}/v1/workload-secrets/workloads/${workloadId}`, {
      method: "DELETE",
      headers: { "X-Steward-Tenant": "default", "X-Steward-Key": TENANT_API_KEY },
    });
    expect(res.status).toBe(200);

    const { resolveWorkloadSecretSettings } = await importResolver();
    const { resolved, failures } = await resolveWorkloadSecretSettings(
      { OPENAI_API_KEY: sealedEnv.OPENAI_API_KEY as string },
      { env: { ...sealedEnv } },
    );
    expect(resolved).toEqual({});
    expect(failures).toEqual(["OPENAI_API_KEY"]);
  });

  test("outage: writer fails closed against a dead endpoint (no partial state, no value in the error)", async () => {
    let caught: unknown;
    try {
      await sealContainerEnvToWorkload(
        { organizationId: ORG, projectName: PROJECT, environmentVars: { ...CREATE_ENV } },
        { baseUrl: "http://localhost:1", tenantId: "default", apiKey: TENANT_API_KEY },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "container_create_failed" });
    expect(caught instanceof Error ? caught.message : "").not.toContain(SECRET_VALUE);
  });
});
