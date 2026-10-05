/**
 * Browser E2E for the context inspector against the supported real-local stack.
 * The host persists seeded trajectories in filesystem-backed PGlite; no route
 * interception or response fixture substitutes the API, auth, or renderer.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type TestInfo, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const REAL_LOCAL_STACK = process.env.ELIZA_UI_SMOKE_REAL_LOCAL_STACK === "1";
const CONTEXT_INSPECTOR_E2E =
  process.env.ELIZA_UI_SMOKE_CONTEXT_INSPECTOR === "1";
const RAW_BODY = ["TOP", " SECRET", " E2E", " BODY"].join("");
const RAW_PATH = ["/private", "/e2e", "/account-"].join("");
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

type NetworkEntry = {
  method: string;
  pathname: string;
  resourceType: string;
  status: number | null;
};

function assertCanariesAbsent(label: string, body: string): void {
  if (body.includes(RAW_BODY)) {
    throw new Error(`${label} contains the raw body canary.`);
  }
  if (body.includes(RAW_PATH)) {
    throw new Error(`${label} contains the raw path canary.`);
  }
}

async function writeEvidenceArtifact(
  testInfo: TestInfo,
  relativePath: string,
  body: string,
): Promise<string> {
  const artifactPath = testInfo.outputPath(...relativePath.split("/"));
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, body, "utf8");
  return artifactPath;
}

test.describe("real-local context inspector", () => {
  test.skip(
    !REAL_LOCAL_STACK || !CONTEXT_INSPECTOR_E2E,
    "requires the gated real-local context inspector evidence stack",
  );
  test.setTimeout(180_000);

  test("authorizes, pages, redacts, and renders real PGlite trajectories", async ({
    page,
  }, testInfo) => {
    const runId = process.env.ELIZA_UI_SMOKE_RUN_ID?.trim();
    const configuredSourceSha = process.env.GITHUB_SHA?.trim();
    const backendLogSetting =
      process.env.ELIZA_UI_SMOKE_BACKEND_LOG_PATH?.trim();
    expect(runId, "the evidence lane requires an exact run id").toBeTruthy();
    expect(
      configuredSourceSha,
      "the evidence lane requires GITHUB_SHA",
    ).toBeTruthy();
    expect(
      backendLogSetting,
      "the evidence lane requires ELIZA_UI_SMOKE_BACKEND_LOG_PATH",
    ).toBeTruthy();
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    expect(sourceSha).toMatch(/^[a-f0-9]{40}$/);
    expect(
      configuredSourceSha,
      "GITHUB_SHA must identify the checkout under test",
    ).toBe(sourceSha);

    const pageErrors: string[] = [];
    const inspectorDiagnostics: string[] = [];
    const inspectorResponses: string[] = [];
    const networkEntries: NetworkEntry[] = [];
    let uiStarted = false;
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      if (
        uiStarted &&
        new URL(request.url()).pathname === "/api/context-inspector"
      ) {
        inspectorDiagnostics.push(
          `requestfailed: ${request.failure()?.errorText ?? "unknown"}`,
        );
      }
    });
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      networkEntries.push({
        method: response.request().method(),
        pathname,
        resourceType: response.request().resourceType(),
        status: response.status(),
      });
      if (pathname === "/api/context-inspector") {
        if (uiStarted && !response.ok()) {
          inspectorDiagnostics.push(`http.${response.status()}`);
        }
      }
    });

    const recordApiResponse = (
      method: string,
      pathname: string,
      status: number,
    ) => {
      networkEntries.push({
        method,
        pathname,
        resourceType: "api-request-context",
        status,
      });
    };

    const firstRunStatus = await page.request.get("/api/first-run/status");
    recordApiResponse("GET", "/api/first-run/status", firstRunStatus.status());
    expect(firstRunStatus.ok()).toBe(true);
    if (!((await firstRunStatus.json()) as { complete?: boolean }).complete) {
      const completed = await page.request.post("/api/first-run", {
        data: { name: "Context Inspector E2E" },
      });
      recordApiResponse("POST", "/api/first-run", completed.status());
      expect(completed.ok()).toBe(true);
    }
    const completedStatus = await page.request.get("/api/first-run/status");
    recordApiResponse("GET", "/api/first-run/status", completedStatus.status());
    expect(completedStatus.ok()).toBe(true);
    expect(await completedStatus.json()).toMatchObject({ complete: true });

    const conversationResponse = await page.request.post("/api/conversations", {
      data: {
        title: "Context inspector real-local evidence",
        metadata: { scope: "general" },
      },
    });
    recordApiResponse(
      "POST",
      "/api/conversations",
      conversationResponse.status(),
    );
    expect(conversationResponse.ok()).toBe(true);
    const conversation = (await conversationResponse.json()) as {
      conversation?: { id?: string; roomId?: string };
    };
    const conversationId = conversation.conversation?.id;
    const roomId = conversation.conversation?.roomId;
    expect(conversationId).toBeTruthy();
    expect(roomId).toBeTruthy();

    const seedResponse = await page.request.post(
      "/api/device-e2e/context-inspector/seed",
      { data: { conversationId, roomId, count: 21 } },
    );
    recordApiResponse(
      "POST",
      "/api/device-e2e/context-inspector/seed",
      seedResponse.status(),
    );
    expect(seedResponse.status()).toBe(200);
    expect(await seedResponse.json()).toEqual({ count: 21, conversationId });

    const first = await page.request.get(
      `/api/context-inspector?conversationId=${conversationId}&offset=0&limit=1`,
    );
    recordApiResponse("GET", "/api/context-inspector", first.status());
    expect(first.status()).toBe(200);
    expect(first.headers()["cache-control"]).toBe("no-store");
    const firstBody = await first.text();
    inspectorResponses.push(firstBody);
    assertCanariesAbsent("first direct inspector response", firstBody);
    const firstPage = JSON.parse(firstBody) as {
      entries: Array<{ reference: string }>;
      page: { hasMore: boolean; nextOffset: number | null };
    };
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.entries[0]?.reference).toMatch(/^ctx_[a-f0-9]{20}$/);
    expect(firstPage.page).toMatchObject({ hasMore: true, nextOffset: 1 });

    const second = await page.request.get(
      `/api/context-inspector?conversationId=${conversationId}&offset=1&limit=1`,
    );
    recordApiResponse("GET", "/api/context-inspector", second.status());
    expect(second.status()).toBe(200);
    const secondBody = await second.text();
    inspectorResponses.push(secondBody);
    assertCanariesAbsent("second direct inspector response", secondBody);
    const secondPage = JSON.parse(secondBody) as {
      entries: Array<{ reference: string }>;
      page: { hasPrevious: boolean };
    };
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.page.hasPrevious).toBe(true);
    expect(secondPage.entries[0]?.reference).not.toBe(
      firstPage.entries[0]?.reference,
    );

    const last = await page.request.get(
      `/api/context-inspector?conversationId=${conversationId}&offset=20&limit=20`,
    );
    recordApiResponse("GET", "/api/context-inspector", last.status());
    expect(last.status()).toBe(200);
    const lastBody = await last.text();
    inspectorResponses.push(lastBody);
    assertCanariesAbsent("last direct inspector response", lastBody);
    expect(
      (JSON.parse(lastBody) as { entries: unknown[] }).entries,
    ).toHaveLength(1);

    const invalid = await page.request.get(
      `/api/context-inspector?conversationId=${conversationId}&offset=-1`,
    );
    recordApiResponse("GET", "/api/context-inspector", invalid.status());
    expect(invalid.status()).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Invalid context inspector request",
    });

    await seedAppStorage(page, {
      "eliza:chat:activeConversationId": conversationId ?? "",
      "eliza:developerMode": "1",
    });
    uiStarted = true;
    await openAppPath(page, "/apps/context-inspector");
    const view = page.getByTestId("context-inspector-view");
    await expect(view).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("context-inspector-entry")).toHaveCount(20);
    await expect(
      page.getByTestId("context-inspector-reference").first(),
    ).toHaveText(/^ctx_[a-f0-9]{20}$/);
    await expect(page.getByText("expired").first()).toBeVisible();
    await expect(page.getByTestId("context-inspector-budget")).toContainText(
      "Requests",
    );
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByTestId("context-inspector-entry")).toHaveCount(1, {
      timeout: 45_000,
    });
    await expect(page.getByText("Trajectory window 21–40")).toBeVisible();

    const visibleText = await view.innerText();
    assertCanariesAbsent("context inspector rendered view", visibleText);
    assertCanariesAbsent(
      "direct context inspector response set",
      inspectorResponses.join("\n"),
    );
    expect(inspectorDiagnostics).toEqual([]);
    expect(pageErrors).toEqual([]);

    const databaseResponse = await page.request.get(
      "/api/device-e2e/context-inspector/database-state",
    );
    recordApiResponse(
      "GET",
      "/api/device-e2e/context-inspector/database-state",
      databaseResponse.status(),
    );
    expect(databaseResponse.status()).toBe(200);
    const databaseState = (await databaseResponse.json()) as {
      adapter: string | null;
      counts: {
        declaredSteps: number;
        indexedSteps: number;
        llmCalls: number;
        materializedTrajectories: number;
        normalizedStepRows: number;
        snapshotBytes: number;
        trajectories: number;
      };
      engine: string | null;
      runId: string | null;
      schema: string;
      source: string;
      sourceSha: string | null;
    };
    expect(databaseState).toEqual({
      schema: "eliza.context-inspector-db-state/v1",
      runId,
      sourceSha: configuredSourceSha,
      engine: "pglite",
      adapter: "PgliteDatabaseAdapter",
      source: "context-inspector-e2e",
      counts: {
        trajectories: 21,
        declaredSteps: 21,
        indexedSteps: 21,
        normalizedStepRows: 0,
        llmCalls: 21,
        materializedTrajectories: 21,
        snapshotBytes: expect.any(Number),
      },
    });
    expect(databaseState.counts.snapshotBytes).toBeGreaterThan(21_000);

    const screenshotPath = testInfo.outputPath(
      "context-inspector-real-local-desktop.png",
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await writeFile(
      testInfo.outputPath("context-inspector-wire.json"),
      JSON.stringify(
        {
          conversationId,
          inspectorResponses: inspectorResponses.map((body) =>
            JSON.parse(body),
          ),
        },
        null,
        2,
      ),
    );

    const databaseArtifactBody = `${JSON.stringify(
      { ...databaseState, capturedFromSourceSha: sourceSha },
      null,
      2,
    )}\n`;
    assertCanariesAbsent("database-state artifact", databaseArtifactBody);
    const databaseArtifactPath = await writeEvidenceArtifact(
      testInfo,
      "e2e-artifacts/database/rows.json",
      databaseArtifactBody,
    );
    await testInfo.attach("real PGlite database state", {
      path: databaseArtifactPath,
      contentType: "application/json",
    });

    const networkArtifactBody = `${JSON.stringify(
      {
        schema: "eliza.context-inspector-network-log/v1",
        runId,
        sourceSha,
        entries: networkEntries,
      },
      null,
      2,
    )}\n`;
    assertCanariesAbsent("network-log artifact", networkArtifactBody);
    const networkArtifactPath = await writeEvidenceArtifact(
      testInfo,
      "e2e-artifacts/network/requests.har",
      networkArtifactBody,
    );
    await testInfo.attach("sanitized browser and API network log", {
      path: networkArtifactPath,
      contentType: "application/json",
    });

    const backendLogPath = path.resolve(REPO_ROOT, backendLogSetting ?? "");
    const backendLog = await readFile(backendLogPath, "utf8");
    expect(backendLog).toContain("[device-e2e-host-agent] real API up on");
    expect(backendLog).toContain(
      "[trajectories] Trajectories service initialized",
    );
    expect(backendLog).not.toContain("[trajectory-logger] Failed");
    expect(backendLog).not.toContain("TrajectoriesService.detachedWrite");
    assertCanariesAbsent("backend-log artifact", backendLog);
    const backendArtifactBody = [
      `# schema=eliza.context-inspector-backend-log/v1`,
      `# runId=${runId}`,
      `# sourceSha=${sourceSha}`,
      backendLog,
    ].join("\n");
    const backendArtifactPath = await writeEvidenceArtifact(
      testInfo,
      "e2e-artifacts/backend/server.log",
      backendArtifactBody,
    );
    await testInfo.attach("real-local backend log", {
      path: backendArtifactPath,
      contentType: "text/plain",
    });
  });
});
