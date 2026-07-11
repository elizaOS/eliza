// Runtime inventory for shell-rendered builtin views. The source-level coverage
// ratchets prove hooks exist; this spec proves those hooks actually register
// under the mounted ShellViewAgentSurface and are drivable through the same
// view-interact bridge chat/voice responses use.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

interface AgentElement {
  id: string;
  role: string;
  label: string;
  status?: string;
  value?: unknown;
  fillable: boolean;
  clickable: boolean;
}

declare global {
  interface Window {
    __ELIZA_BRIDGE__?: {
      readonly viewInteract?: (
        viewId: string,
        viewType: string,
        capability: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  }
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const FILE_HASH_A = "a".repeat(64);
const FILE_HASH_B = "b".repeat(64);
const FILES_FIXTURE = {
  files: [
    {
      fileName: `${FILE_HASH_A}.png`,
      url: `/api/media/${FILE_HASH_A}.png`,
      hash: FILE_HASH_A,
      mimeType: "image/png",
      size: 20_480,
      createdAt: 1_700_000_002_000,
    },
    {
      fileName: `${FILE_HASH_B}.pdf`,
      url: `/api/media/${FILE_HASH_B}.pdf`,
      hash: FILE_HASH_B,
      mimeType: "application/pdf",
      size: 51_200,
      createdAt: 1_700_000_001_000,
    },
  ],
};

const TRANSCRIPT_ID = "transcript-smoke-1";
const TRANSCRIPT_SUMMARY = {
  id: TRANSCRIPT_ID,
  title: "Smoke transcript",
  status: "ready",
  createdAt: 1_700_000_003_000,
  durationMs: 42_000,
  speakerCount: 1,
  preview: "Bridge inventory transcript row.",
};
const TRANSCRIPT_DETAIL = {
  ...TRANSCRIPT_SUMMARY,
  source: "microphone",
  scope: "user-private",
  roomId: "ui-smoke-room",
  segments: [
    {
      id: "seg-1",
      speaker: "Speaker 1",
      text: "Bridge inventory transcript row.",
      startMs: 0,
      endMs: 1200,
    },
  ],
};

const SHELL_VIEW_TARGETS: readonly {
  label: string;
  path: string;
  viewId: string;
  readyTestId: string;
  requiredIds: readonly string[];
}[] = [
  {
    label: "Knowledge",
    path: "/character/documents",
    viewId: "documents",
    readyTestId: "documents-view",
    requiredIds: ["scope-all", "document-doc-smoke-1"],
  },
  {
    label: "Character",
    path: "/character/personality",
    viewId: "character",
    readyTestId: "character-editor-view",
    requiredIds: ["identity-bio"],
  },
  {
    label: "Settings",
    path: "/settings",
    viewId: "settings",
    readyTestId: "settings-shell",
    requiredIds: ["section-identity", "section-ai-model"],
  },
  {
    label: "Tasks",
    path: "/apps/tasks",
    viewId: "tasks",
    readyTestId: "tasks-view",
    requiredIds: ["input-search-tasks", "toggle-show-archived"],
  },
  {
    label: "Transcripts",
    path: "/apps/transcripts",
    viewId: "transcripts",
    readyTestId: "live-meeting-page",
    requiredIds: [`transcript-${TRANSCRIPT_ID}`],
  },
  {
    label: "Files",
    path: "/apps/files",
    viewId: "files",
    readyTestId: "files-view",
    requiredIds: ["file-facet-all", `file-download-${FILE_HASH_A}-png`],
  },
  {
    label: "Relationships",
    path: "/apps/relationships",
    viewId: "relationships",
    readyTestId: "relationships-view",
    requiredIds: ["relationships-platform"],
  },
  {
    label: "Logs",
    path: "/apps/logs",
    viewId: "logs",
    readyTestId: "logs-view",
    requiredIds: ["logs-filter-level", "logs-clear"],
  },
  {
    label: "Database",
    path: "/apps/database",
    viewId: "database",
    readyTestId: "database-view",
    requiredIds: ["tab-tables", "editor-mode-query"],
  },
  {
    label: "Trajectories",
    path: "/apps/trajectories",
    viewId: "trajectories",
    readyTestId: "trajectories-view",
    requiredIds: ["trajectories-export-open", "trajectories-clear-all-open"],
  },
];

async function installBridgeInventoryFixtures(page: Page): Promise<void> {
  await page.route("**/api/files", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(FILES_FIXTURE),
    }),
  );
  await page.route("**/api/media/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: TINY_PNG,
    }),
  );
  await page.route("**/api/transcripts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transcripts: [TRANSCRIPT_SUMMARY] }),
    }),
  );
  await page.route(`**/api/transcripts/${TRANSCRIPT_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transcript: TRANSCRIPT_DETAIL }),
    }),
  );
}

async function waitForAgentBridge(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => typeof window.__ELIZA_BRIDGE__?.viewInteract === "function",
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function interact(
  page: Page,
  viewId: string,
  capability: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return page.evaluate(
    async ({ viewId, capability, params }) => {
      const bridge = window.__ELIZA_BRIDGE__?.viewInteract;
      if (!bridge) throw new Error("view-interact bridge not installed");
      return bridge(viewId, "gui", capability, params);
    },
    { viewId, capability, params },
  );
}

async function listAgentElements(
  page: Page,
  viewId: string,
): Promise<AgentElement[]> {
  return (await interact(page, viewId, "list-elements")) as AgentElement[];
}

async function expectAgentIds(
  page: Page,
  viewId: string,
  expectedIds: readonly string[],
  label: string,
): Promise<void> {
  await expect
    .poll(
      async () => (await listAgentElements(page, viewId)).map(({ id }) => id),
      {
        message: `${label} exposes ${expectedIds.join(", ")} through the agent bridge`,
        timeout: 30_000,
      },
    )
    .toEqual(expect.arrayContaining([...expectedIds]));
}

async function describeElement(
  page: Page,
  viewId: string,
  id: string,
): Promise<AgentElement | null> {
  return (await interact(page, viewId, "describe-element", {
    id,
  })) as AgentElement | null;
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installBridgeInventoryFixtures(page);
});

test("shell views expose concrete chat/voice-drivable controls through the agent bridge", async ({
  page,
}) => {
  for (const target of SHELL_VIEW_TARGETS) {
    await openAppPath(page, target.path);
    await expect(page.getByTestId(target.readyTestId)).toBeVisible({
      timeout: 60_000,
    });
    await waitForAgentBridge(page);
    await expectAgentIds(page, target.viewId, target.requiredIds, target.label);
  }
});

test("shell bridge can fill and click representative editable controls", async ({
  page,
}) => {
  await openAppPath(page, "/character/personality");
  await expect(page.getByTestId("character-editor-view")).toBeVisible({
    timeout: 60_000,
  });
  await waitForAgentBridge(page);
  const bioFill = (await interact(page, "character", "agent-fill", {
    id: "identity-bio",
    value: "Bridge-edited character bio.",
  })) as { ok?: boolean };
  expect(bioFill?.ok).toBe(true);
  await expect
    .poll(
      async () =>
        (await describeElement(page, "character", "identity-bio"))?.value,
      { timeout: 5_000 },
    )
    .toBe("Bridge-edited character bio.");

  await openAppPath(page, "/apps/logs");
  await expect(page.getByTestId("logs-view")).toBeVisible({ timeout: 60_000 });
  const levelFill = (await interact(page, "logs", "agent-fill", {
    id: "logs-filter-level",
    value: "error",
  })) as { ok?: boolean };
  expect(levelFill?.ok).toBe(true);
  await expect
    .poll(
      async () =>
        (await describeElement(page, "logs", "logs-filter-level"))?.value,
      { timeout: 5_000 },
    )
    .toBe("error");

  await openAppPath(page, "/apps/database");
  await expect(page.getByTestId("database-view")).toBeVisible({
    timeout: 60_000,
  });
  const sqlClick = (await interact(page, "database", "agent-click", {
    id: "editor-mode-query",
  })) as { ok?: boolean };
  expect(sqlClick?.ok).toBe(true);
  await expect(page.getByPlaceholder(/SELECT.*FROM/i).first()).toBeVisible({
    timeout: 10_000,
  });
});
