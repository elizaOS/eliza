// @vitest-environment jsdom
/**
 * REAL mock-cloud-stack e2e for the frontend-hosting dashboard tab (#10690).
 *
 * Nothing between the component and the database is mocked-of-the-subject:
 * this boots the actual Cloud API Hono route graph
 * (`packages/scripts/cloud/admin/dev/cloud-api-hono-dev.ts`) on a real port
 * with PGlite + MOCK_REDIS + the in-memory R2 `BLOB` binding, performs a real
 * headless SIWE signup (viem-signed message → real `eliza_*` API key row),
 * creates a real app, and then drives the REAL `<AppFrontendHosting>` tree
 * (real `CloudI18nProvider`, real `frontend-hosting` lib, real cloud
 * `api-client`) against that live server. The only shim is a fetch wrapper
 * that resolves the dashboard's same-origin relative `/api/*` URLs onto the
 * test server's base — jsdom has no same-origin backend to ride.
 *
 * Covered end to end: empty state → publish v1 (file picker → base64 bundle)
 * → publish v2 → rollback to v1 via the confirm dialog → delete-active 409
 * surfaced from a real out-of-band activation race → delete non-active →
 * owner preview serving the actual stored bytes.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { frontendPreviewPath } from "../lib/frontend-hosting";
import { AppFrontendHosting } from "../components/app-frontend-hosting";
import { CloudI18nProvider } from "../../shell/CloudI18nProvider";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
);
// Leg-3 test-port range (363xx); distinct from the smoke script's 36311.
const PORT = 36312;
const BASE = `http://127.0.0.1:${PORT}`;

let pgdataDir: string;
let server: ChildProcess | null = null;
let apiKey: string;
let appId: string;
const realFetch = globalThis.fetch;

function serverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MOCK_REDIS: "1",
    DATABASE_URL: `pglite://${pgdataDir}`,
    API_DEV_PORT: String(PORT),
    CRON_SECRET: "local-cron-secret",
    // Api-key encryption needs a KMS; pin the local backend with a fixed
    // root key so SIWE signup works without a steward KMS deployment.
    ELIZA_KMS_BACKEND: "local",
    ELIZA_LOCAL_ROOT_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
}

function runToExit(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      env: serverEnv(),
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
  });
}

/** Raw HTTP against the live server — used for setup + server-state asserts. */
async function raw<T>(
  method: string,
  p: string,
  body?: unknown,
  key?: string,
): Promise<{ status: number; data: T }> {
  const res = await realFetch(`${BASE}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

interface DeploymentRow {
  id: string;
  version: number;
  status: string;
}

async function serverDeployments(): Promise<{
  active_deployment_id: string | null;
  deployments: DeploymentRow[];
}> {
  const { data } = await raw<{
    active_deployment_id: string | null;
    deployments: DeploymentRow[];
  }>("GET", `/api/v1/apps/${appId}/frontend`, undefined, apiKey);
  return data;
}

function renderHostingTab() {
  return render(
    <CloudI18nProvider initialLang="en">
      <AppFrontendHosting appId={appId} />
    </CloudI18nProvider>,
  );
}

function pickFiles(files: File[]) {
  fireEvent.change(screen.getByTestId("hosting-files-input"), {
    target: { files },
  });
}

async function publishThroughUi(html: string) {
  pickFiles([new File([html], "index.html", { type: "text/html" })]);
  await screen.findByTestId("hosting-selection-summary");
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByTestId("hosting-publish"));
}

beforeAll(async () => {
  pgdataDir = mkdtempSync(path.join(tmpdir(), "w3-hosting-e2e-pg-"));

  await runToExit("bun", [
    "run",
    "--cwd",
    "packages/cloud/shared",
    "db:migrate",
  ]);

  server = spawn(
    "bun",
    ["run", "packages/scripts/cloud/admin/dev/cloud-api-hono-dev.ts"],
    { cwd: REPO_ROOT, env: serverEnv(), stdio: ["ignore", "inherit", "inherit"] },
  );

  let healthy = false;
  for (let i = 0; i < 240 && !healthy; i++) {
    try {
      const res = await realFetch(`${BASE}/api/health`);
      healthy = res.ok;
    } catch {
      // still booting
    }
    if (!healthy) await new Promise((r) => setTimeout(r, 500));
  }
  if (!healthy) throw new Error("cloud-api-hono-dev never became healthy");

  // Headless SIWE → a real `eliza_*` API key row in PGlite.
  const nonce = await raw<{
    domain: string;
    nonce: string;
    uri: string;
    version?: string;
    statement?: string;
    chainId?: number;
  }>("GET", "/api/auth/siwe/nonce?chainId=1");
  expect(nonce.status).toBe(200);
  const account = privateKeyToAccount(generatePrivateKey());
  const message = createSiweMessage({
    address: account.address,
    chainId: nonce.data.chainId || 1,
    domain: nonce.data.domain,
    nonce: nonce.data.nonce,
    uri: nonce.data.uri,
    version: (nonce.data.version as "1" | undefined) || "1",
    statement: nonce.data.statement,
  });
  const verify = await raw<{ apiKey?: string }>(
    "POST",
    "/api/auth/siwe/verify",
    { message, signature: await account.signMessage({ message }) },
  );
  if (!verify.data.apiKey) {
    throw new Error(`SIWE verify failed: ${verify.status}`);
  }
  apiKey = verify.data.apiKey;
  expect(apiKey.startsWith("eliza_")).toBe(true);

  const created = await raw<{ app?: { id: string } }>(
    "POST",
    "/api/v1/apps",
    {
      name: "w3-hosting-e2e",
      app_url: "https://example.com",
      skipGitHubRepo: true,
    },
    apiKey,
  );
  if (!created.data.app?.id) {
    throw new Error(`app creation failed: ${created.status}`);
  }
  appId = created.data.app.id;

  // The dashboard api-client sends `Authorization: Bearer <localStorage
  // steward token>` on same-origin relative URLs. Give it the real key and
  // resolve those relative URLs onto the live test server.
  window.localStorage.setItem(STEWARD_TOKEN_KEY, apiKey);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" && input.startsWith("/")
        ? `${BASE}${input}`
        : input;
    return realFetch(url as RequestInfo, init);
  }) as typeof fetch;
}, 600_000);

afterAll(() => {
  globalThis.fetch = realFetch;
  server?.kill("SIGTERM");
  if (pgdataDir) rmSync(pgdataDir, { recursive: true, force: true });
});

afterEach(() => {
  cleanup();
});

describe("frontend hosting tab against the real mock cloud stack (#10690)", () => {
  it("renders the real empty state from the live API", async () => {
    renderHostingTab();
    expect(await screen.findByText("No deployments yet")).toBeTruthy();
  });

  it("publishes v1 through the file picker and the row goes live", async () => {
    renderHostingTab();
    await screen.findByText("No deployments yet");

    await publishThroughUi("<html><body>w3-v1</body></html>");

    await screen.findByTestId("hosting-deployment-1", undefined, {
      timeout: 30_000,
    });
    expect(screen.getByText("live")).toBeTruthy();

    const state = await serverDeployments();
    expect(state.deployments).toHaveLength(1);
    expect(state.deployments[0].status).toBe("active");
    expect(state.active_deployment_id).toBe(state.deployments[0].id);
  });

  it("publishes v2 then rolls back to v1 via the confirm dialog", async () => {
    renderHostingTab();
    await screen.findByTestId("hosting-deployment-1");

    await publishThroughUi("<html><body>w3-v2</body></html>");
    await screen.findByTestId("hosting-deployment-2", undefined, {
      timeout: 30_000,
    });

    // v1 is now superseded; its action button is the rollback.
    const rollback = await screen.findByTestId("hosting-activate-1");
    expect(rollback.textContent).toContain("Roll back");

    const user = userEvent.setup({ delay: null });
    await user.click(rollback);
    await user.click(await screen.findByTestId("hosting-activate-confirm"));

    await waitFor(
      async () => {
        const state = await serverDeployments();
        const v1 = state.deployments.find((d) => d.version === 1);
        expect(v1?.status).toBe("active");
        expect(state.active_deployment_id).toBe(v1?.id);
      },
      { timeout: 30_000 },
    );
    // The rolled-back row renders as live again.
    await waitFor(() => expect(screen.getByText("live")).toBeTruthy());
  });

  it("surfaces the real 409 when a delete races an out-of-band activation", async () => {
    renderHostingTab();
    // v1 active, v2 superseded → v2 shows a delete button.
    const deleteV2 = await screen.findByTestId("hosting-delete-2");

    // Race: another client activates v2 AFTER this view rendered.
    const before = await serverDeployments();
    const v2 = before.deployments.find((d) => d.version === 2);
    if (!v2) throw new Error("expected v2 on the server");
    const activated = await raw(
      "POST",
      `/api/v1/apps/${appId}/frontend/${v2.id}/activate`,
      undefined,
      apiKey,
    );
    expect(activated.status).toBe(200);

    const user = userEvent.setup({ delay: null });
    await user.click(deleteV2);
    await user.click(await screen.findByTestId("hosting-delete-confirm"));

    // The server refuses; the deployment must still exist.
    await waitFor(
      async () => {
        const state = await serverDeployments();
        expect(
          state.deployments.find((d) => d.version === 2)?.status,
        ).toBe("active");
      },
      { timeout: 30_000 },
    );

    // Restore v1 as active for the following tests (v2 stays deletable).
    const v1 = before.deployments.find((d) => d.version === 1);
    if (!v1) throw new Error("expected v1 on the server");
    await raw(
      "POST",
      `/api/v1/apps/${appId}/frontend/${v1.id}/activate`,
      undefined,
      apiKey,
    );
  });

  it("deletes the non-active version for real", async () => {
    renderHostingTab();
    const deleteV2 = await screen.findByTestId("hosting-delete-2");

    const user = userEvent.setup({ delay: null });
    await user.click(deleteV2);
    await user.click(await screen.findByTestId("hosting-delete-confirm"));

    await waitFor(
      () => expect(screen.queryByTestId("hosting-deployment-2")).toBeNull(),
      { timeout: 30_000 },
    );
    const state = await serverDeployments();
    expect(state.deployments.map((d) => d.version)).toEqual([1]);
  });

  it("owner preview serves the active bundle's actual bytes", async () => {
    const res = await realFetch(`${BASE}${frontendPreviewPath(appId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // v1 is active after the rollback + delete above.
    expect(html).toContain("w3-v1");
  });
});
