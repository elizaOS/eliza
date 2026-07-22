/**
 * Live create→render→edit→render proof for agent-built plugin views. The real
 * planner, coding task, verifier, directory loader, registry, and renderer run.
 */

import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";
const LIVE_CREATE_EDIT = process.env.ELIZA_UI_SMOKE_VIEW_CREATE_EDIT === "1";
const COMPOSER =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const SEND =
  '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]';

interface TaskSummary {
  id: string;
  status: string;
  workdir?: string | null;
  createdAt?: string;
  lastError?: string;
  metadata?: Record<string, unknown>;
}

interface ViewSummary {
  id: string;
  label: string;
  path?: string;
  pluginName: string;
  available: boolean;
  bundleHash?: string;
  bundleUrlVersioned?: string;
  pluginDir?: string;
}

interface ConversationSummary {
  id: string;
  roomId: string;
}

interface ConversationMessage {
  id?: string;
  role?: string;
  source?: string;
  text?: string;
}

interface ConversationTranscript {
  messages?: ConversationMessage[];
}

interface TrajectoryListItem {
  id?: string;
  trajectoryId?: string;
  status?: string;
}

interface TrajectoryIndex {
  trajectories?: TrajectoryListItem[];
  total?: number;
  offset?: number;
  limit?: number;
}

interface PhaseTaskEvidence {
  sessions: TaskSummary[];
  sessionIds: string[];
  taskIds: string[];
}

function validatorPluginName(
  session: TaskSummary | undefined,
): string | undefined {
  const validator = session?.metadata?.validator;
  if (!validator || typeof validator !== "object" || Array.isArray(validator)) {
    return undefined;
  }
  const params = (validator as Record<string, unknown>).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const pluginName = (params as Record<string, unknown>).pluginName;
  return typeof pluginName === "string" && pluginName.length > 0
    ? pluginName
    : undefined;
}

interface OrchestratorTaskEvidence {
  id?: string;
  artifacts?: Array<{
    artifactType?: string;
    path?: string | null;
    sessionId?: string | null;
  }>;
  events?: unknown[];
}

interface PhaseTrajectoryEvidence {
  ids: string[];
  details: Array<{ id: string; body: unknown }>;
}

interface RawTrajectoryDetail {
  id: string;
  body: unknown;
}

interface ProofManifest {
  conversation?: ConversationSummary;
  token?: string;
  createdMarker?: string;
  editedMarker?: string;
  createSessionIds: string[];
  editSessionIds: string[];
  createTaskIds: string[];
  editTaskIds: string[];
  createTrajectoryIds: string[];
  editTrajectoryIds: string[];
  workdir?: string | null;
  pluginDir?: string;
  viewId?: string;
  pluginName?: string;
  createdHash?: string;
  editedHash?: string;
  createVerdictMessageId?: string;
  editVerdictMessageId?: string;
  completed: boolean;
  evidenceErrors: string[];
}

const VERIFIED_LOADED_TEXT = "plugin built, verified, and loaded live";
const PLUGIN_DOMAIN_MAX_ENTRIES = 1_000;
const PLUGIN_DOMAIN_MAX_FILES = 500;
const PLUGIN_DOMAIN_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const PLUGIN_DOMAIN_MAX_FILE_BYTES = 5 * 1024 * 1024;
const PLUGIN_DOMAIN_MAX_DEPTH = 12;
const RAW_EVIDENCE_MAX_ENTRIES = 2_000;
const RAW_EVIDENCE_MAX_FILES = 50;
const RAW_EVIDENCE_MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const RAW_EVIDENCE_MAX_FILE_BYTES = 10 * 1024 * 1024;

async function attachJson(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    contentType: "application/json",
  });
}

function safeAttachmentToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 160);
}

function sessionTaskId(session: TaskSummary): string | undefined {
  const taskId = session.metadata?.taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : undefined;
}

function referencedRawArtifactPaths(task: OrchestratorTaskEvidence): string[] {
  const paths = new Set(
    (task.artifacts ?? [])
      .filter((artifact) => artifact.artifactType === "trajectory")
      .map((artifact) => artifact.path)
      .filter((path): path is string => Boolean(path)),
  );
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "stdoutLogPath" || key === "trajectoryPath") &&
        typeof child === "string" &&
        child.length > 0
      ) {
        paths.add(child);
      }
      visit(child);
    }
  };
  visit(task.events);
  return [...paths].sort();
}

async function attachReferencedTaskArtifacts(
  testInfo: TestInfo,
  phase: "create" | "edit",
  taskId: string,
  task: OrchestratorTaskEvidence,
): Promise<void> {
  const manifest: Array<{
    path: string;
    bytes?: number;
    sha256?: string;
    attached: boolean;
    reason?: string;
  }> = [];
  let attachedFiles = 0;
  let totalBytes = 0;
  for (const path of referencedRawArtifactPaths(task)) {
    const info = await lstat(path).catch(() => null);
    if (!info) {
      manifest.push({ path, attached: false, reason: "missing" });
      continue;
    }
    if (info.isSymbolicLink()) {
      manifest.push({ path, attached: false, reason: "symlink" });
      continue;
    }
    if (!info.isFile()) {
      manifest.push({ path, attached: false, reason: "not a file" });
      continue;
    }
    if (!/\.(?:json|ndjson|ndjson\.1)$/u.test(path)) {
      manifest.push({
        path,
        bytes: info.size,
        attached: false,
        reason: "unsupported artifact type",
      });
      continue;
    }
    if (
      info.size > RAW_EVIDENCE_MAX_FILE_BYTES ||
      totalBytes + info.size > RAW_EVIDENCE_MAX_TOTAL_BYTES ||
      attachedFiles >= RAW_EVIDENCE_MAX_FILES
    ) {
      manifest.push({
        path,
        bytes: info.size,
        attached: false,
        reason: "raw evidence attachment limit",
      });
      continue;
    }
    const body = await readFile(path);
    const sha256 = createHash("sha256").update(body).digest("hex");
    await testInfo.attach(
      `${phase}-task-${safeAttachmentToken(taskId)}-raw-${safeAttachmentToken(path)}-${sha256.slice(0, 8)}`,
      {
        body,
        contentType: path.includes("ndjson")
          ? "application/x-ndjson"
          : "application/json",
      },
    );
    totalBytes += body.byteLength;
    attachedFiles += 1;
    manifest.push({
      path,
      bytes: body.byteLength,
      sha256,
      attached: true,
    });
  }
  await attachJson(
    testInfo,
    `${phase}-task-${safeAttachmentToken(taskId)}-raw-artifacts-manifest.json`,
    { taskId, attachedFiles, totalBytes, files: manifest },
  );
}

async function attachPhaseTaskEvidence(
  page: Page,
  testInfo: TestInfo,
  phase: "create" | "edit",
  previousIds: Set<string>,
): Promise<PhaseTaskEvidence> {
  const listed = await listTasks(page);
  const discovered = listed.filter((task) => !previousIds.has(task.id));
  expect(
    discovered.length,
    `${phase} must create at least one coding-agent session`,
  ).toBeGreaterThan(0);

  const sessions: TaskSummary[] = [];
  const outputs: string[] = [];
  for (const discoveredSession of discovered) {
    const taskId = discoveredSession.id;
    const attachmentId = safeAttachmentToken(taskId);
    const sessionResponse = await page.request.get(
      `/api/coding-agents/${encodeURIComponent(taskId)}`,
    );
    const sessionBody = (await sessionResponse.json()) as TaskSummary;
    await attachJson(testInfo, `${phase}-coding-session-${attachmentId}.json`, {
      status: sessionResponse.status(),
      body: sessionBody,
    });
    expect(sessionResponse.ok()).toBe(true);
    sessions.push(sessionBody);

    const outputResponse = await page.request.get(
      `/api/coding-agents/${encodeURIComponent(taskId)}/output?lines=2000`,
    );
    const outputBody = (await outputResponse.json()) as {
      sessionId?: string;
      output?: string;
    };
    const output = outputBody.output ?? "";
    await testInfo.attach(`${phase}-coding-output-${attachmentId}.txt`, {
      body: Buffer.from(output),
      contentType: "text/plain",
    });
    expect(outputResponse.ok()).toBe(true);
    outputs.push(output);
  }

  const taskIds = [
    ...new Set(
      sessions
        .map(sessionTaskId)
        .filter((taskId): taskId is string => Boolean(taskId)),
    ),
  ];
  for (const taskId of taskIds) {
    const response = await page.request.get(
      `/api/orchestrator/tasks/${encodeURIComponent(taskId)}`,
    );
    const body = (await response.json()) as OrchestratorTaskEvidence;
    await attachJson(
      testInfo,
      `${phase}-orchestrator-task-${safeAttachmentToken(taskId)}.json`,
      { status: response.status(), body },
    );
    expect(response.ok(), `${phase} orchestrator task must be readable`).toBe(
      true,
    );
    await attachReferencedTaskArtifacts(testInfo, phase, taskId, body);
  }

  expect(
    outputs.some((output) => output.includes("PLUGIN_CREATE_DONE")),
    `${phase} session lineage must contain the structured plugin proof`,
  ).toBe(true);
  return {
    sessions,
    sessionIds: sessions.map((session) => session.id),
    taskIds,
  };
}

async function attachViewState(
  page: Page,
  testInfo: TestInfo,
  phase: "created" | "edited",
  viewId: string,
): Promise<ViewSummary> {
  const viewResponse = await page.request.get(
    `/api/views/${encodeURIComponent(viewId)}`,
  );
  const view = (await viewResponse.json()) as ViewSummary;
  await attachJson(testInfo, `${phase}-view.json`, {
    status: viewResponse.status(),
    body: view,
  });
  expect(viewResponse.ok()).toBe(true);
  return view;
}

async function attachCurrentView(
  page: Page,
  testInfo: TestInfo,
  phase: "created" | "edited",
  expectedViewId: string,
): Promise<void> {
  const response = await page.request.get("/api/views/current");
  const body = (await response.json()) as {
    currentView?: { viewId?: string } | null;
  };
  await attachJson(testInfo, `${phase}-current-view.json`, {
    status: response.status(),
    body,
  });
  expect(response.ok()).toBe(true);
  expect(body.currentView?.viewId).toBe(expectedViewId);
}

async function putViewInForegroundForRouting(
  page: Page,
  testInfo: TestInfo,
  viewId: string,
  viewPath: string,
): Promise<void> {
  const registeredView = (await listViews(page)).find(
    (view) => view.id === viewId,
  );
  expect(registeredView?.available, `${viewId} must be available`).toBe(true);

  // Use the same navigation report as a user-initiated switch. The edit that
  // follows must honor its explicit target even while another view is current.
  const response = await page.request.post(
    `/api/views/${encodeURIComponent(viewId)}/navigate`,
    {
      data: { source: "user", path: viewPath },
    },
  );
  const body = await response.json();
  await attachJson(testInfo, "pre-edit-foreground-view.json", {
    status: response.status(),
    body,
  });
  expect(response.ok(), `foregrounding ${viewId} must succeed`).toBe(true);
  await expect
    .poll(async () => {
      const currentResponse = await page.request.get("/api/views/current");
      if (!currentResponse.ok()) return null;
      const currentBody = (await currentResponse.json()) as {
        currentView?: { viewId?: string } | null;
      };
      return currentBody.currentView?.viewId ?? null;
    })
    .toBe(viewId);
}

async function settleViewForScreenshot(page: Page): Promise<void> {
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  if ((await overlay.getAttribute("data-open")) === "true") {
    await page.locator(COMPOSER).first().press("Escape");
    await expect(overlay).not.toHaveAttribute("data-open", "true", {
      timeout: 10_000,
    });
  }

  // Task completion and first-run notices are useful during the workflow but
  // must not cover the view pixels that reviewers are being asked to inspect.
  const visibleDismissButtons = page.locator(
    '[data-testid="notification-banner-dismiss"]:visible',
  );
  for (let count = 0; count < 20; count += 1) {
    if ((await visibleDismissButtons.count()) === 0) break;
    await visibleDismissButtons.first().click();
    await page.waitForTimeout(100);
  }

  // Let the chat spring and banner exit transitions finish so the artifact is
  // a stable frame rather than an intermediate animation state.
  await page.waitForTimeout(600);
  await expect(overlay).not.toHaveAttribute("data-open", "true");
  await expect(visibleDismissButtons).toHaveCount(0);
}

async function scrollProofMarkerIntoView(
  surface: Locator,
  marker: string,
): Promise<void> {
  // The coding agent owns presentation, so the proof marker may be standalone,
  // embedded in the intent, or repeated without changing its evidentiary value.
  await surface.getByText(marker).first().scrollIntoViewIfNeeded();
}

async function attachBundle(
  page: Page,
  testInfo: TestInfo,
  phase: "created" | "edited",
  view: ViewSummary,
): Promise<Buffer> {
  const response = await page.request.get(
    view.bundleUrlVersioned ??
      `/api/views/${encodeURIComponent(view.id)}/bundle.js`,
  );
  const body = await response.body();
  await testInfo.attach(`${phase}-bundle.js`, {
    body,
    contentType: "text/javascript",
  });
  await attachJson(testInfo, `${phase}-bundle-headers.json`, {
    status: response.status(),
    headers: response.headers(),
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: body.byteLength,
  });
  expect(response.ok(), `${phase} view bundle must be serviceable`).toBe(true);
  return body;
}

async function attachPluginDomain(
  testInfo: TestInfo,
  phase: "created" | "edited",
  pluginDir: string,
  taskWorkdir: string,
): Promise<void> {
  // macOS exposes the same temporary directory through both /var and
  // /private/var; canonical paths keep that alias from failing containment.
  const [root, workdir] = await Promise.all([
    realpath(resolve(pluginDir)),
    realpath(resolve(taskWorkdir)),
  ]);
  expect(root === workdir || root.startsWith(`${workdir}${sep}`)).toBe(true);
  const files: Array<{
    path: string;
    kind: "file" | "symlink";
    bytes: number;
    sha256?: string;
    text?: string;
    linkTarget?: string;
    omitted?: "file-limit" | "file-too-large" | "total-byte-limit";
  }> = [];
  const omitted: string[] = [];
  let entriesVisited = 0;
  let totalBytesRead = 0;
  let truncated = false;

  const visit = async (path: string, depth: number): Promise<void> => {
    if (
      truncated ||
      depth > PLUGIN_DOMAIN_MAX_DEPTH ||
      entriesVisited >= PLUGIN_DOMAIN_MAX_ENTRIES
    ) {
      truncated = true;
      return;
    }
    entriesVisited += 1;
    const info = await lstat(path);
    const rel = relative(root, path);
    if (info.isSymbolicLink()) {
      files.push({
        path: rel,
        kind: "symlink",
        bytes: info.size,
        linkTarget: await readlink(path),
      });
      return;
    }
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) {
        await visit(join(path, entry), depth + 1);
        if (truncated) break;
      }
      return;
    }
    if (!info.isFile()) return;
    if (files.length >= PLUGIN_DOMAIN_MAX_FILES) {
      files.push({
        path: rel,
        kind: "file",
        bytes: info.size,
        omitted: "file-limit",
      });
      truncated = true;
      return;
    }
    if (info.size > PLUGIN_DOMAIN_MAX_FILE_BYTES) {
      files.push({
        path: rel,
        kind: "file",
        bytes: info.size,
        omitted: "file-too-large",
      });
      omitted.push(rel);
      return;
    }
    if (totalBytesRead + info.size > PLUGIN_DOMAIN_MAX_TOTAL_BYTES) {
      files.push({
        path: rel,
        kind: "file",
        bytes: info.size,
        omitted: "total-byte-limit",
      });
      omitted.push(rel);
      truncated = true;
      return;
    }
    const body = await readFile(path);
    totalBytesRead += body.byteLength;
    files.push({
      path: rel,
      kind: "file",
      bytes: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      ...(/\.(?:json|tsx?|md|css|svg)$/u.test(rel) && body.byteLength <= 200_000
        ? { text: body.toString("utf8") }
        : {}),
    });
  };
  for (const target of [
    "package.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "vitest.config.ts",
    "biome.json",
    "src",
    "tests",
    "assets",
    "dist/views/bundle.js",
  ]) {
    const path = join(root, target);
    if (await lstat(path).catch(() => null)) await visit(path, 0);
  }
  await attachJson(testInfo, `${phase}-plugin-domain.json`, {
    pluginDir: root,
    taskWorkdir: workdir,
    entriesVisited,
    totalBytesRead,
    truncated,
    omitted,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  });
}

async function readRawTrajectoryDetails(): Promise<RawTrajectoryDetail[]> {
  const configuredDir = process.env.ELIZA_TRAJECTORY_DIR?.trim();
  if (!configuredDir) return [];
  const root = resolve(configuredDir);
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) return [];

  const details: RawTrajectoryDetail[] = [];
  for (const file of await listEvidenceFiles(root)) {
    if (
      !file.path.endsWith(".json") ||
      file.bytes > RAW_EVIDENCE_MAX_FILE_BYTES
    ) {
      continue;
    }
    let trajectory: unknown;
    try {
      trajectory = JSON.parse(await readFile(file.path, "utf8"));
    } catch {
      // error-policy:J3 a recorder file still being replaced is explicitly
      // unready; the next polling pass retries it instead of accepting it.
      continue;
    }
    if (!trajectory || typeof trajectory !== "object") continue;
    const record = trajectory as Record<string, unknown>;
    const id = record.trajectoryId ?? record.id;
    if (typeof id !== "string" || id.length === 0) continue;
    details.push({
      id,
      body: {
        source: "raw-trajectory-file",
        path: relative(root, file.path),
        trajectory,
      },
    });
  }
  return details;
}

async function trajectorySnapshot(page: Page): Promise<{
  body: TrajectoryIndex;
  ids: Set<string>;
  rawDetails: RawTrajectoryDetail[];
}> {
  const response = await page.request.get("/api/trajectories?limit=500");
  expect(response.ok(), "trajectory index must be available").toBe(true);
  const body = (await response.json()) as TrajectoryIndex;
  const rawDetails = await readRawTrajectoryDetails();
  return {
    body,
    ids: new Set(
      [
        ...(body.trajectories ?? []).map(
          (item) => item.id ?? item.trajectoryId,
        ),
        ...rawDetails.map((detail) => detail.id),
      ].filter((id): id is string => Boolean(id)),
    ),
    rawDetails,
  };
}

function trajectoryStatus(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const trajectory = (body as { trajectory?: unknown }).trajectory;
  if (!trajectory || typeof trajectory !== "object") return undefined;
  const status = (trajectory as { status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
}

async function waitForFinalizedCorrelatedTrajectories(
  page: Page,
  testInfo: TestInfo,
  phase: "create" | "edit",
  previousIds: Set<string>,
  roomId: string,
  phaseMarker: string,
): Promise<PhaseTrajectoryEvidence> {
  const deadline = Date.now() + 90_000;
  let latestIndex: TrajectoryIndex = { trajectories: [] };
  let latestDetails: Array<{ id: string; body: unknown }> = [];
  while (Date.now() < deadline) {
    const snapshot = await trajectorySnapshot(page);
    latestIndex = snapshot.body;
    const details: Array<{ id: string; body: unknown }> =
      snapshot.rawDetails.filter((detail) => {
        if (previousIds.has(detail.id)) return false;
        const serialized = JSON.stringify(detail.body);
        if (!serialized.includes(roomId) || !serialized.includes(phaseMarker)) {
          return false;
        }
        const status = trajectoryStatus(detail.body);
        return status === "finished" || status === "completed";
      });
    const candidateIds = (snapshot.body.trajectories ?? [])
      .map((item) => item.id ?? item.trajectoryId)
      .filter(
        (id): id is string =>
          typeof id === "string" && id.length > 0 && !previousIds.has(id),
      );
    for (const id of candidateIds) {
      const response = await page.request.get(
        `/api/trajectories/${encodeURIComponent(id)}`,
      );
      if (!response.ok()) continue;
      const body = await response.json();
      const serialized = JSON.stringify(body);
      if (!serialized.includes(roomId)) continue;
      const status = trajectoryStatus(body);
      if (status === "active" || status === "running") continue;
      details.push({ id, body });
    }
    latestDetails = details;
    if (details.length > 0) {
      await attachJson(
        testInfo,
        `${phase}-trajectories-index.json`,
        latestIndex,
      );
      for (const detail of details) {
        await attachJson(
          testInfo,
          `${phase}-trajectory-${safeAttachmentToken(detail.id)}.json`,
          {
            correlatedRoomId: roomId,
            phaseMarkerPresent: JSON.stringify(detail.body).includes(
              phaseMarker,
            ),
            body: detail.body,
          },
        );
      }
      return { ids: details.map((detail) => detail.id), details };
    }
    await page.waitForTimeout(1_000);
  }

  await attachJson(testInfo, `${phase}-trajectories-timeout.json`, {
    roomId,
    phaseMarker,
    index: latestIndex,
    details: latestDetails,
  });
  throw new Error(
    `${phase} did not produce a finalized trajectory correlated to room ${roomId}`,
  );
}

function verifiedLoadedMessages(
  transcript: ConversationTranscript,
): ConversationMessage[] {
  return (transcript.messages ?? []).filter(
    (message) =>
      message.source === "verification-room-bridge" &&
      message.text?.includes(VERIFIED_LOADED_TEXT),
  );
}

async function fetchConversationTranscript(
  page: Page,
  conversationId: string,
): Promise<ConversationTranscript> {
  const response = await page.request.get(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
  );
  expect(response.ok(), "conversation transcript must be available").toBe(true);
  return (await response.json()) as ConversationTranscript;
}

async function waitForNewVerifiedLoadedVerdict(
  page: Page,
  testInfo: TestInfo,
  phase: "create" | "edit",
  conversationId: string,
  previousVerdictIds: Set<string>,
): Promise<{
  transcript: ConversationTranscript;
  verdict: ConversationMessage;
  verdictIds: Set<string>;
}> {
  const deadline = Date.now() + 60_000;
  let latest: ConversationTranscript = { messages: [] };
  while (Date.now() < deadline) {
    latest = await fetchConversationTranscript(page, conversationId);
    const verdicts = verifiedLoadedMessages(latest);
    const verdict = verdicts.find(
      (message) => message.id && !previousVerdictIds.has(message.id),
    );
    if (verdict) {
      await attachJson(testInfo, `${phase}-verification-verdict.json`, verdict);
      return {
        transcript: latest,
        verdict,
        verdictIds: new Set(
          verdicts
            .map((message) => message.id)
            .filter((id): id is string => Boolean(id)),
        ),
      };
    }
    await page.waitForTimeout(1_000);
  }
  await attachJson(testInfo, `${phase}-verification-verdict-timeout.json`, {
    expectedText: VERIFIED_LOADED_TEXT,
    previousVerdictIds: [...previousVerdictIds],
    transcript: latest,
  });
  throw new Error(
    `${phase} did not persist a new verified-and-loaded verdict in the originating conversation`,
  );
}

async function listEvidenceFiles(
  root: string,
): Promise<Array<{ path: string; bytes: number }>> {
  const files: Array<{ path: string; bytes: number }> = [];
  let entries = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (entries >= RAW_EVIDENCE_MAX_ENTRIES || depth > 12) return;
    entries += 1;
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) {
        await visit(join(path, entry), depth + 1);
        if (entries >= RAW_EVIDENCE_MAX_ENTRIES) break;
      }
      return;
    }
    if (info.isFile()) {
      files.push({ path, bytes: info.size });
    }
  };
  await visit(root, 0);
  return files;
}

async function attachRawTrajectoryEvidence(
  testInfo: TestInfo,
  proof: ProofManifest,
): Promise<void> {
  const configuredDir = process.env.ELIZA_TRAJECTORY_DIR?.trim();
  if (!configuredDir) {
    await attachJson(testInfo, "raw-trajectory-artifacts-unavailable.json", {
      available: false,
      reason:
        "ELIZA_TRAJECTORY_DIR was not externalized; the live harness owns and removes its state-scoped trajectory directory",
    });
    return;
  }
  const root = resolve(configuredDir);
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    await attachJson(testInfo, "raw-trajectory-artifacts-unavailable.json", {
      available: false,
      configuredDir: root,
      reason: "configured trajectory directory does not exist",
    });
    return;
  }

  const correlationTokens = [
    proof.conversation?.roomId,
    proof.token,
    proof.createdMarker,
    proof.editedMarker,
  ].filter((value): value is string => Boolean(value));
  const sessionIds = new Set([
    ...proof.createSessionIds,
    ...proof.editSessionIds,
  ]);
  const manifest: Array<{
    path: string;
    bytes: number;
    sha256?: string;
    attached: boolean;
    reason?: string;
  }> = [];
  let attachedFiles = 0;
  let totalBytes = 0;
  for (const file of await listEvidenceFiles(root)) {
    const rel = relative(root, file.path);
    if (!/\.(?:json|ndjson|ndjson\.1)$/u.test(rel)) continue;
    const sessionPathMatch = [...sessionIds].some((id) => rel.includes(id));
    if (
      file.bytes > RAW_EVIDENCE_MAX_FILE_BYTES ||
      totalBytes + file.bytes > RAW_EVIDENCE_MAX_TOTAL_BYTES ||
      attachedFiles >= RAW_EVIDENCE_MAX_FILES
    ) {
      manifest.push({
        path: rel,
        bytes: file.bytes,
        attached: false,
        reason: "raw evidence attachment limit",
      });
      continue;
    }
    const body = await readFile(file.path);
    const correlated =
      sessionPathMatch ||
      correlationTokens.some((token) => body.includes(Buffer.from(token)));
    if (!correlated) continue;
    const sha256 = createHash("sha256").update(body).digest("hex");
    await testInfo.attach(
      `raw-${safeAttachmentToken(rel)}-${sha256.slice(0, 8)}`,
      {
        body,
        contentType: rel.includes("ndjson")
          ? "application/x-ndjson"
          : "application/json",
      },
    );
    totalBytes += body.byteLength;
    attachedFiles += 1;
    manifest.push({
      path: rel,
      bytes: body.byteLength,
      sha256,
      attached: true,
    });
  }
  await attachJson(testInfo, "raw-trajectory-artifacts-manifest.json", {
    available: true,
    root,
    attachedFiles,
    totalBytes,
    files: manifest,
  });
}

async function sendChat(
  page: Page,
  text: string,
  mayNavigate = false,
): Promise<void> {
  const composer = page.locator(COMPOSER).first();
  const send = page.locator(SEND).first();
  await expect(composer).toBeVisible({ timeout: 60_000 });
  await composer.fill(text);
  await expect(send).toBeEnabled();
  await send.click();
  if (mayNavigate) {
    await expect
      .poll(
        async () =>
          new URL(page.url()).pathname !== "/chat" ||
          (await page
            .locator('[data-testid="chat-message"][data-role="user"]')
            .filter({ hasText: text })
            .last()
            .isVisible()
            .catch(() => false)),
        { timeout: 30_000 },
      )
      .toBe(true);
    return;
  }
  await expect(composer).toHaveValue("", { timeout: 30_000 });
}

async function listTasks(page: Page): Promise<TaskSummary[]> {
  const response = await page.request.get("/api/coding-agents");
  expect(response.ok(), "coding-agent session list must be available").toBe(
    true,
  );
  return (await response.json()) as TaskSummary[];
}

async function waitForNewTask(
  page: Page,
  previousIds: Set<string>,
  createChoiceLabel?: string,
): Promise<TaskSummary> {
  const deadline = Date.now() + 15 * 60_000;
  let latest: TaskSummary | undefined;
  let choiceSubmitted = false;
  while (Date.now() < deadline) {
    const tasks = await listTasks(page);
    latest = tasks.find((task) => !previousIds.has(task.id));
    if (latest) return latest;
    if (createChoiceLabel && !choiceSubmitted) {
      const choice = page
        .getByRole("button", {
          name: createChoiceLabel,
          exact: true,
        })
        .last();
      if (await choice.isVisible().catch(() => false)) {
        await choice.click();
        choiceSubmitted = true;
      }
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error("VIEWS did not start a coding task within 15 minutes");
}

async function waitForTaskDone(
  page: Page,
  taskId: string,
): Promise<TaskSummary> {
  // Live coding agents may run package installation, all four verification
  // commands, and an artifact review in one prompt. Keep this phase bound
  // finite, but do not cancel a healthy real-model task at the old 15-minute
  // threshold while it is still producing tool events.
  const deadline = Date.now() + 25 * 60_000;
  let status = "missing";
  while (Date.now() < deadline) {
    const response = await page.request.get(
      `/api/coding-agents/${encodeURIComponent(taskId)}`,
    );
    if (response.ok()) {
      const task = (await response.json()) as TaskSummary;
      status = task.status;
      if (["completed", "stopped"].includes(status)) return task;
      if (["errored", "cancelled", "blocked"].includes(status)) {
        throw new Error(
          `coding task ${taskId} ended with status ${status}${task.lastError ? `: ${task.lastError}` : ""}`,
        );
      }
    }
    await page.waitForTimeout(3_000);
  }
  throw new Error(`coding task ${taskId} did not finish (last=${status})`);
}

async function listViews(page: Page): Promise<ViewSummary[]> {
  const response = await page.request.get("/api/views");
  expect(response.ok(), "view registry must be available").toBe(true);
  const body = (await response.json()) as { views?: ViewSummary[] };
  return body.views ?? [];
}

async function waitForView(
  page: Page,
  token: string,
  previousHash?: string,
): Promise<ViewSummary> {
  const deadline = Date.now() + 3 * 60_000;
  let candidate: ViewSummary | undefined;
  while (Date.now() < deadline) {
    candidate = (await listViews(page)).find((view) =>
      `${view.id} ${view.label} ${view.pluginName}`
        .toLowerCase()
        .includes(token),
    );
    if (
      candidate?.available &&
      candidate.bundleHash &&
      candidate.bundleHash !== previousHash
    ) {
      return candidate;
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error(
    `view ${token} never became available with a fresh bundle hash (${candidate ? JSON.stringify(candidate) : "not registered"})`,
  );
}

async function activateConversation(page: Page): Promise<ConversationSummary> {
  await seedAppStorage(page);
  await openAppPath(page, "/chat");

  await expect
    .poll(
      () =>
        page.evaluate(() =>
          localStorage.getItem("eliza:chat:activeConversationId"),
        ),
      {
        message: "chat must hydrate an active conversation before the proof",
        timeout: 30_000,
      },
    )
    .toBeTruthy();

  const id = await page.evaluate(() =>
    localStorage.getItem("eliza:chat:activeConversationId"),
  );
  const response = await page.request.get("/api/conversations");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    conversations?: ConversationSummary[];
  };
  const conversation = body.conversations?.find(
    (candidate) => candidate.id === id,
  );
  if (!conversation) {
    throw new Error("hydrated conversation did not resolve to its server room");
  }
  return conversation;
}

test.skip(
  !LIVE_STACK || !LIVE_CREATE_EDIT,
  "requires ELIZA_UI_SMOKE_LIVE_STACK=1 and ELIZA_UI_SMOKE_VIEW_CREATE_EDIT=1",
);

test("creates, renders, edits, and hot-reloads a real plugin view", async ({
  page,
}, testInfo) => {
  test.setTimeout(60 * 60_000);
  if (!process.env.ELIZA_TRAJECTORY_DIR?.trim()) {
    throw new Error(
      "live create/edit proof requires ELIZA_TRAJECTORY_DIR so room-correlated native trajectories survive stack teardown",
    );
  }
  const proof: ProofManifest = {
    createSessionIds: [],
    editSessionIds: [],
    createTaskIds: [],
    editTaskIds: [],
    createTrajectoryIds: [],
    editTrajectoryIds: [],
    completed: false,
    evidenceErrors: [],
  };

  try {
    await installDefaultAppRoutes(page);
    const conversation = await activateConversation(page);
    proof.conversation = conversation;
    const trajectoriesBeforeCreate = await trajectorySnapshot(page);
    await attachJson(testInfo, "views-before.json", {
      views: await listViews(page),
    });

    const suffix = Date.now().toString(36).slice(-6);
    const token = `proof-surface-${suffix}`;
    const createdMarker = `VIEW_CREATED_${suffix.toUpperCase()}`;
    const editedMarker = `VIEW_EDITED_${suffix.toUpperCase()}`;
    proof.token = token;
    proof.createdMarker = createdMarker;
    proof.editedMarker = editedMarker;

    const verdictIdsBeforeCreate = new Set(
      verifiedLoadedMessages(
        await fetchConversationTranscript(page, conversation.id),
      )
        .map((message) => message.id)
        .filter((id): id is string => Boolean(id)),
    );
    const beforeCreate = new Set(
      (await listTasks(page)).map((task) => task.id),
    );
    await sendChat(
      page,
      `Use the VIEWS tool with action=create and intent="${token} ${createdMarker} Proof Surface ${suffix}". Build a finished release GUI surface named ${token}. Its rendered page must visibly include the exact marker ${createdMarker} and a heading containing "Proof Surface". Include real tests and a compiled bundle. Do not merely explain the steps.`,
    );
    const createTask = await waitForNewTask(
      page,
      beforeCreate,
      "Create a new view plugin",
    );
    proof.createSessionIds = [createTask.id];
    await waitForTaskDone(page, createTask.id);

    const createTaskEvidence = await attachPhaseTaskEvidence(
      page,
      testInfo,
      "create",
      beforeCreate,
    );
    proof.createSessionIds = createTaskEvidence.sessionIds;
    proof.createTaskIds = createTaskEvidence.taskIds;
    const createdSession =
      createTaskEvidence.sessions.find(
        (session) => session.id === createTask.id,
      ) ?? createTaskEvidence.sessions[0];
    const expectedPluginName = validatorPluginName(createdSession);
    expect(
      expectedPluginName,
      "create session must identify its plugin",
    ).toBeTruthy();
    proof.workdir = createdSession?.workdir;
    proof.pluginName = expectedPluginName;

    const createVerdict = await waitForNewVerifiedLoadedVerdict(
      page,
      testInfo,
      "create",
      conversation.id,
      verdictIdsBeforeCreate,
    );
    proof.createVerdictMessageId = createVerdict.verdict.id;

    const createdViewSummary = await waitForView(
      page,
      expectedPluginName as string,
    );
    const createdView = await attachViewState(
      page,
      testInfo,
      "created",
      createdViewSummary.id,
    );
    expect(createdView.bundleUrlVersioned).toContain(createdView.bundleHash);
    const createdBundle = await attachBundle(
      page,
      testInfo,
      "created",
      createdView,
    );
    expect(createdView.pluginDir).toBeTruthy();
    expect(createdSession?.workdir).toBeTruthy();
    proof.pluginDir = createdView.pluginDir;
    proof.viewId = createdView.id;
    proof.pluginName = createdView.pluginName;
    proof.createdHash = createdView.bundleHash;
    await attachPluginDomain(
      testInfo,
      "created",
      createdView.pluginDir as string,
      createdSession?.workdir as string,
    );

    await openAppPath(page, "/chat");
    await sendChat(
      page,
      `Use the VIEWS tool with action=show and view=${createdView.id}. Open it now.`,
      true,
    );
    const createdSurface = page.locator(
      `[data-eliza-view-id="${createdView.id}"]`,
    );
    await expect(createdSurface).toContainText(createdMarker, {
      timeout: 90_000,
    });
    await expect(
      page.getByRole("heading", { name: /Proof Surface/iu }).first(),
    ).toBeVisible();
    await attachCurrentView(page, testInfo, "created", createdView.id);
    await settleViewForScreenshot(page);
    const createdDesktop = testInfo.outputPath("created-desktop.png");
    await page.screenshot({
      path: createdDesktop,
      fullPage: true,
    });
    await testInfo.attach("created-desktop.png", {
      path: createdDesktop,
      contentType: "image/png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await settleViewForScreenshot(page);
    const createdMobile = testInfo.outputPath("created-mobile.png");
    await page.screenshot({
      path: createdMobile,
      fullPage: true,
    });
    await testInfo.attach("created-mobile.png", {
      path: createdMobile,
      contentType: "image/png",
    });
    await scrollProofMarkerIntoView(createdSurface, createdMarker);
    await page.waitForTimeout(300);
    const createdMobileProof = testInfo.outputPath("created-mobile-proof.png");
    await page.screenshot({
      path: createdMobileProof,
      fullPage: true,
    });
    await testInfo.attach("created-mobile-proof.png", {
      path: createdMobileProof,
      contentType: "image/png",
    });
    await page.setViewportSize({ width: 1280, height: 720 });

    const createTrajectories = await waitForFinalizedCorrelatedTrajectories(
      page,
      testInfo,
      "create",
      trajectoriesBeforeCreate.ids,
      conversation.roomId,
      createdMarker,
    );
    proof.createTrajectoryIds = createTrajectories.ids;
    const trajectoriesBeforeEdit = await trajectorySnapshot(page);
    const beforeEdit = new Set((await listTasks(page)).map((task) => task.id));
    await openAppPath(page, "/chat");
    await putViewInForegroundForRouting(page, testInfo, "cockpit", "/cockpit");
    await sendChat(
      page,
      `Use the VIEWS tool with action=edit and view=${createdView.id}. Replace the visible marker ${createdMarker} with the exact marker ${editedMarker}; keep the rest of the view working, update its real test, run every verification command, and rebuild the bundle.`,
    );
    const editTask = await waitForNewTask(page, beforeEdit);
    proof.editSessionIds = [editTask.id];
    await waitForTaskDone(page, editTask.id);

    const editTaskEvidence = await attachPhaseTaskEvidence(
      page,
      testInfo,
      "edit",
      beforeEdit,
    );
    proof.editSessionIds = editTaskEvidence.sessionIds;
    proof.editTaskIds = editTaskEvidence.taskIds;
    const editedSession =
      editTaskEvidence.sessions.find((session) => session.id === editTask.id) ??
      editTaskEvidence.sessions[0];
    expect(editedSession?.workdir).toBeTruthy();
    expect(editedSession?.workdir).toBe(createdSession?.workdir);

    const editVerdict = await waitForNewVerifiedLoadedVerdict(
      page,
      testInfo,
      "edit",
      conversation.id,
      createVerdict.verdictIds,
    );
    proof.editVerdictMessageId = editVerdict.verdict.id;

    const editedViewSummary = await waitForView(
      page,
      createdView.pluginName,
      createdView.bundleHash,
    );
    const editedView = await attachViewState(
      page,
      testInfo,
      "edited",
      editedViewSummary.id,
    );
    expect(editedView.id).toBe(createdView.id);
    expect(editedView.pluginName).toBe(createdView.pluginName);
    expect(editedView.pluginDir).toBeTruthy();
    const editedBundle = await attachBundle(
      page,
      testInfo,
      "edited",
      editedView,
    );
    expect(editedBundle.equals(createdBundle)).toBe(false);
    await attachPluginDomain(
      testInfo,
      "edited",
      editedView.pluginDir as string,
      editedSession?.workdir as string,
    );
    await openAppPath(page, "/chat");
    await sendChat(
      page,
      `Use the VIEWS tool with action=show and view=${editedView.id}. Open the edited view now.`,
      true,
    );
    const editedSurface = page.locator(
      `[data-eliza-view-id="${editedView.id}"]`,
    );
    await expect(editedSurface).toContainText(editedMarker, {
      timeout: 90_000,
    });
    // The original marker remains correctly preserved in the chat transcript;
    // only the hot-reloaded view surface must stop rendering it.
    await expect(editedSurface).not.toContainText(createdMarker);
    await expect(
      page.getByRole("heading", { name: /Proof Surface/iu }).first(),
    ).toBeVisible();
    await attachCurrentView(page, testInfo, "edited", editedView.id);
    await settleViewForScreenshot(page);
    const editedDesktop = testInfo.outputPath("edited-desktop.png");
    await page.screenshot({
      path: editedDesktop,
      fullPage: true,
    });
    await testInfo.attach("edited-desktop.png", {
      path: editedDesktop,
      contentType: "image/png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await settleViewForScreenshot(page);
    const editedMobile = testInfo.outputPath("edited-mobile.png");
    await page.screenshot({
      path: editedMobile,
      fullPage: true,
    });
    await testInfo.attach("edited-mobile.png", {
      path: editedMobile,
      contentType: "image/png",
    });
    await scrollProofMarkerIntoView(editedSurface, editedMarker);
    await page.waitForTimeout(300);
    const editedMobileProof = testInfo.outputPath("edited-mobile-proof.png");
    await page.screenshot({
      path: editedMobileProof,
      fullPage: true,
    });
    await testInfo.attach("edited-mobile-proof.png", {
      path: editedMobileProof,
      contentType: "image/png",
    });

    const editTrajectories = await waitForFinalizedCorrelatedTrajectories(
      page,
      testInfo,
      "edit",
      trajectoriesBeforeEdit.ids,
      conversation.roomId,
      editedMarker,
    );
    proof.editTrajectoryIds = editTrajectories.ids;
    const transcript = await fetchConversationTranscript(page, conversation.id);
    await attachJson(testInfo, "conversation-transcript.json", transcript);
    expect(verifiedLoadedMessages(transcript).length).toBeGreaterThanOrEqual(2);

    proof.pluginDir = editedView.pluginDir;
    proof.viewId = editedView.id;
    proof.pluginName = editedView.pluginName;
    proof.editedHash = editedView.bundleHash;
    proof.completed = true;
  } finally {
    // The live harness removes its state root as soon as the test process exits;
    // copy any externalized raw evidence into Playwright attachments while every
    // session and trajectory correlation key is still available.
    try {
      await attachRawTrajectoryEvidence(testInfo, proof);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      proof.evidenceErrors.push(`raw trajectory evidence: ${message}`);
      await testInfo.attach("raw-trajectory-artifacts-error.txt", {
        body: Buffer.from(`${message}\n`),
        contentType: "text/plain",
      });
    }
    await attachJson(testInfo, "live-proof-manifest.json", {
      ...proof,
      capturedAt: new Date().toISOString(),
    });
  }
});
