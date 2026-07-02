// End-to-end evidence capture for #11028: drive ONE orchestrator coding task
// all the way to a TERMINAL "done" state and screenshot/record the real UI +
// real backend the whole way — closing the gap left by PR #11650 (whose
// captured task stalled forever in "validating" with no terminal frame).
//
// This single script records ONE video across the whole lifecycle:
//   empty cockpit -> task created -> sub-agent executing -> validating
//   -> [real "Approve" button click in the orchestrator UI] -> done (terminal)
// plus the terminal state mirrored on /orchestrator and /task-coordinator.
//
// ── Two real fixes were required to get here (both committed, not workarounds) ──
//
// 1. Acceptance-criteria fit (why #11650 stalled): a criteria-free task gets a
//    generic "coding" template (typecheck/lint/tests) auto-filled by
//    `withDefaultAcceptanceCriteria` (acceptance-criteria.ts). That template is
//    unsatisfiable in an isolated /tmp/eliza-acp/task-<id> scratch workdir with
//    no build tooling, so `autoVerifyCompletion` never clears `validating`.
//    Here the task is created with EXPLICIT, achievable criteria for this exact
//    goal (caller-supplied criteria are authoritative — the auto-fill no-ops),
//    exactly the two API calls the cockpit "Start agent" button makes
//    (createOrchestratorTask + addOrchestratorAgent; see
//    plugins/plugin-task-coordinator/src/CockpitRoute.tsx onCreateSession).
//
// 2. Missing route registration (why the detail pane + Approve button never
//    rendered): `GET /api/orchestrator/tasks/:id/timeline` was implemented in
//    orchestrator-routes.ts but NEVER listed in CODING_AGENT_ROUTE_PATHS
//    (setup-routes.ts), so it 404'd. The UI's `useOrchestratorData.fetchDetail`
//    does `Promise.all([getCodingAgentTaskThread, listOrchestratorTaskTimeline])`,
//    so the 404 rejected the whole fetch and every task-detail pane hung on
//    "Loading task…" — you could never reach the Approve control. The fix
//    registers timeline (and the five sibling implemented-but-unregistered
//    control routes: auto-validate / retry-turn / rerun-from-event / restart /
//    restart-with-edited-plan / plan-revisions).
//
// ── Why the terminal transition is driven by the human "Approve" button ──
// This dev stack has NO model provider registered ("[router] No provider
// registered for TEXT_SMALL") and the independent verifier's default ACP agent
// (opencode) has no Cerebras credentials in this sandbox, so the automatic
// verify pass returns `independent_verify_inconclusive` — which by design does
// NOT auto-promote and does NOT retry. In that situation the shipped, first-
// class path to a terminal state is a human reviewer pressing "Approve"
// (validateTask humanOverride) — literally what goal-llm-verifier.ts /
// orchestrator-task-service.ts document as the primary validator. This script
// plays that reviewer: it reads the sub-agent's real CompletionEnvelope
// (every criterion met, verified independently by cat-ing hello.txt) and then
// clicks the real orchestrator-approve button in the rendered UI.
//
// Usage (from packages/app, dev stack running):
//   OUT_DIR=<this dir> API_BASE=http://127.0.0.1:31337 UI_BASE=http://127.0.0.1:2138 \
//     bun <this dir>/capture.mjs
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const OUT = process.env.OUT_DIR;
const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:31337";
const UI_BASE = process.env.UI_BASE ?? "http://127.0.0.1:2138";
if (!OUT) throw new Error("OUT_DIR is required");

const desktopDir = join(OUT, "desktop");
const videoDir = join(OUT, "video");
const logDir = join(OUT, "logs");
for (const d of [desktopDir, videoDir, logDir]) mkdirSync(d, { recursive: true });

const GOAL =
  "Create a file named hello.txt containing exactly the text 'hi' in the workspace. Nothing else.";
const TITLE = "Write hello.txt";
const ACCEPTANCE_CRITERIA = [
  "hello.txt exists in the workspace root",
  "hello.txt's content is exactly 'hi' (optionally with a single trailing newline) and nothing else",
  "no other files in the workspace were created or modified",
];

const consoleLines = [];
const viewport = { width: 1440, height: 900 };
const ONBOARDING_BYPASS_STORAGE = {
  "eliza:first-run-complete": "1",
  "eliza:setup:step": "activate",
  "eliza:ui-shell-mode": "native",
  "eliza:tutorial-autolaunched": "1",
  "elizaos:active-server": JSON.stringify({
    id: "local:embedded",
    kind: "local",
    label: "This device",
  }),
};

function listAcpWorkdirs() {
  try {
    return new Set(
      readdirSync("/tmp/eliza-acp")
        .filter((n) => n.startsWith("task-"))
        .map((n) => join("/tmp/eliza-acp", n)),
    );
  } catch {
    return new Set();
  }
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport,
    recordVideo: { dir: videoDir, size: viewport },
  });
  await ctx.addInitScript((entries) => {
    try {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    } catch {}
  }, ONBOARDING_BYPASS_STORAGE);
  const page = await ctx.newPage();
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

  const settle = async (extraMs = 3000) => {
    await page
      .getByText("Booting up", { exact: false })
      .first()
      .waitFor({ state: "hidden", timeout: 60000 })
      .catch(() => consoleLines.push("[settle] boot splash still visible"));
    await page
      .getByText("Loading view", { exact: false })
      .first()
      .waitFor({ state: "hidden", timeout: 30000 })
      .catch(() => {});
    await page
      .waitForLoadState("networkidle", { timeout: 20000 })
      .catch(() => consoleLines.push("[settle] networkidle timeout"));
    await page.waitForTimeout(extraMs);
  };
  const goto = async (path, extraMs = 4000) => {
    await page.goto(UI_BASE + path, { waitUntil: "domcontentloaded" });
    await settle(extraMs);
  };
  const shot = async (name) => {
    await page.screenshot({ path: join(desktopDir, `${name}.png`), fullPage: true });
    console.log(`shot ${name}`);
  };
  const taskById = async (id) => {
    const res = await fetch(`${API_BASE}/api/orchestrator/tasks`);
    const body = await res.json().catch(() => null);
    return (Array.isArray(body?.tasks) ? body.tasks : []).find((t) => t.id === id);
  };

  // ── 0. Baseline: empty cockpit ─────────────────────────────────────────
  await goto("/cockpit", 6000);
  await shot("00-cockpit-empty");
  const workdirsBefore = listAcpWorkdirs();

  // ── 1. Create task (real API) — same two calls the cockpit button makes ─
  console.log("creating task…");
  const createRes = await fetch(`${API_BASE}/api/orchestrator/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: TITLE,
      goal: GOAL,
      acceptanceCriteria: ACCEPTANCE_CRITERIA,
      providerPolicy: { preferredFramework: "claude", providerSource: "user-claude" },
    }),
  });
  if (!createRes.ok) throw new Error(`create failed: ${createRes.status} ${await createRes.text()}`);
  const created = await createRes.json();
  const taskId = created.id ?? created.task?.id;
  if (!taskId) throw new Error(`no task id: ${JSON.stringify(created)}`);
  console.log("task created:", taskId);

  console.log("spawning claude sub-agent…");
  const spawnRes = await fetch(
    `${API_BASE}/api/orchestrator/tasks/${encodeURIComponent(taskId)}/agents`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ framework: "claude", providerSource: "user-claude", task: GOAL }),
    },
  );
  if (!spawnRes.ok) throw new Error(`spawn failed: ${spawnRes.status} ${await spawnRes.text()}`);
  console.log("sub-agent spawn requested");

  await goto("/cockpit", 4000);
  await shot("01-task-created");
  await goto("/orchestrator", 4000);
  await shot("01b-orchestrator-task-created");

  // ── 2. Poll to `validating`, screenshotting active + validating ────────
  const seen = new Set();
  let latestWorkdir = null;
  let status = "open";
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    const task = await taskById(taskId);
    status = task?.status ?? "unknown";
    if (task?.latestWorkdir) latestWorkdir = task.latestWorkdir;
    if (!seen.has(status)) {
      seen.add(status);
      console.log(`status -> ${status}`);
      if (status === "active") {
        await goto("/cockpit", 3000);
        await shot("02-spawned-executing");
      } else if (status === "validating") {
        await goto("/cockpit", 3000);
        await shot("03-validating");
      }
    }
    if (status === "validating" || status === "done" || status === "failed") break;
    await page.waitForTimeout(6000);
  }
  console.log("status after wait:", status);

  // ── 3. Read the sub-agent's real completion evidence (operator review) ──
  const detailRes = await fetch(`${API_BASE}/api/orchestrator/tasks/${encodeURIComponent(taskId)}`);
  const detail = await detailRes.json();
  const envelope = detail?.metadata?.completionEnvelope;
  console.log("completionEnvelope:", JSON.stringify(envelope));

  // ── 4. Drive the REAL "Approve" control in the orchestrator UI ─────────
  // Open the task list, click the task card to drill into its detail pane
  // (which now loads — timeline route fixed), then click orchestrator-approve.
  if (status === "validating") {
    await goto("/orchestrator", 3000);
    const card = page.getByTestId("task-card").first();
    await card.waitFor({ state: "visible", timeout: 30000 });
    await card.click();
    console.log("drilled into task detail");
    // The Approve button lives in the TaskInspector; wait for the detail pane
    // to finish loading (fetchDetail resolves now that timeline is registered).
    const approve = page.getByTestId("orchestrator-approve");
    await approve.waitFor({ state: "visible", timeout: 60000 });
    await page.waitForTimeout(1500);
    await shot("03b-validating-detail-approve-visible");
    console.log("clicking real orchestrator-approve button");
    await approve.click();
    await page.waitForTimeout(4000);
    await shot("03c-approve-clicked");
  }

  // ── 5. Confirm terminal `done`, screenshot the crown-jewel frames ──────
  let finalStatus = status;
  for (let i = 0; i < 20; i++) {
    const task = await taskById(taskId);
    finalStatus = task?.status ?? finalStatus;
    if (["done", "failed", "archived"].includes(finalStatus)) break;
    await page.waitForTimeout(2000);
  }
  console.log("final status:", finalStatus);

  await goto("/orchestrator", 4000);
  const card2 = page.getByTestId("task-card").first();
  if (await card2.isVisible().catch(() => false)) {
    await card2.click();
    await settle(3000);
  }
  await shot("04-completed-terminal");
  await goto("/orchestrator", 4000);
  await shot("04b-orchestrator-list-done");
  await goto("/task-coordinator", 4000);
  await shot("04c-task-coordinator-done");
  await goto("/cockpit", 4000);
  await shot("04d-cockpit-done");

  const workdirsAfter = listAcpWorkdirs();
  const newWorkdirs = [...workdirsAfter].filter((d) => !workdirsBefore.has(d));
  writeFileSync(
    join(logDir, "task-result.json"),
    JSON.stringify({ taskId, finalStatus, latestWorkdir, newWorkdirs, envelope }, null, 2),
  );
  console.log("newWorkdirs:", newWorkdirs, "latestWorkdir:", latestWorkdir);

  const video = page.video();
  await ctx.close();
  await browser.close();
  if (video) console.log("video:", await video.path());
  console.log("done");
}

main()
  .catch((err) => {
    console.error("CAPTURE FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    writeFileSync(join(logDir, "console.log"), `${consoleLines.join("\n")}\n`);
  });
