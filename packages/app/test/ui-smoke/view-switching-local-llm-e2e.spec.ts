/**
 * Drives local-model view decisions through the real chat composer and
 * renderer navigation pipeline, then writes an HTML report with chat and view
 * screenshots. It requires an eliza-1 GGUF served by llama-server; an
 * unreachable model or incorrect view decision fails after the report is
 * written so every attempted utterance remains inspectable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const LLAMACPP_URL = process.env.LLAMACPP_URL ?? "http://127.0.0.1:8080";
const MODEL_LABEL = process.env.LOCAL_LLM_LABEL ?? "eliza-1 (local)";
const LIVE_LOCAL_MODEL = process.env.ELIZA_UI_SMOKE_LOCAL_LLM_LIVE === "1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "output", "view-switching-local");

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const CHAT_SEND_SELECTOR =
  '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]';

// Registered, route-backed views with on-view render markers (mirrors the
// deterministic spec's contract). The model's chosen view is navigated here.
type ViewDef = { path: string; label: string; onView?: (p: Page) => Locator };
const VIEW_REGISTRY: Record<string, ViewDef> = {
  calendar: {
    path: "/calendar",
    label: "Calendar",
    onView: (p) => p.getByTestId("calendar-view").first(),
  },
  inbox: {
    path: "/inbox",
    label: "Inbox",
    onView: (p) =>
      p
        .getByRole("heading", { name: "Inbox" })
        .first()
        .or(p.locator('section[aria-label="Inbox"]').first()),
  },
  wallet: {
    path: "/wallet",
    label: "Wallet",
    onView: (p) =>
      p
        .getByTestId("wallet-shell")
        .first()
        .or(p.getByRole("heading", { name: "Wallet" }).first()),
  },
  settings: {
    path: "/settings",
    label: "Settings",
    onView: (p) => p.getByTestId("settings-shell").first(),
  },
  todos: { path: "/todos", label: "Todos" },
  "task-coordinator": { path: "/task-coordinator", label: "Task Coordinator" },
};

// Utterances spanning direct / multilingual / contextual + a hard one. expected
// is the correct view; "" means the model SHOULD reply (no navigation).
const CASES: ReadonlyArray<{
  utterance: string;
  expected: string;
  kind: string;
}> = [
  { utterance: "open my calendar", expected: "calendar", kind: "direct" },
  { utterance: "show my wallet", expected: "wallet", kind: "direct" },
  { utterance: "open settings", expected: "settings", kind: "direct" },
  { utterance: "check my messages", expected: "inbox", kind: "direct" },
  { utterance: "show my todos", expected: "todos", kind: "direct" },
  {
    utterance: "muéstrame mi calendario",
    expected: "calendar",
    kind: "multilingual (es)",
  },
  {
    utterance: "montre-moi mon portefeuille",
    expected: "wallet",
    kind: "multilingual (fr)",
  },
  { utterance: "我的待办事项", expected: "todos", kind: "multilingual (zh)" },
  {
    utterance: "I want to add a new feature to my app",
    expected: "task-coordinator",
    kind: "contextual",
  },
  { utterance: "tell me a joke", expected: "", kind: "negative (no nav)" },
];

const VIEW_IDS = [...Object.keys(VIEW_REGISTRY), "none"];
const PLANNER_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["VIEWS", "REPLY"] },
    view: { type: "string", enum: VIEW_IDS },
  },
  required: ["action"],
};
const SYSTEM =
  "You are the action planner for an app with these views: calendar, inbox, wallet, settings, todos, task-coordinator. " +
  "If the user wants to see/open/check/navigate to a surface (in ANY language), action=VIEWS and view=that surface. " +
  "Coding/app-feature work → task-coordinator. Otherwise action=REPLY.";

interface ModelDecision {
  action: string;
  view: string | null;
  raw: string;
}
async function decide(utterance: string): Promise<ModelDecision> {
  const res = await fetch(`${LLAMACPP_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: utterance },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "plan", schema: PLANNER_SCHEMA, strict: true },
      },
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0,
      max_tokens: 40,
    }),
  });
  if (!res.ok)
    throw new Error(`llama-server ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content ?? "";
  let action = "REPLY";
  let view: string | null = null;
  try {
    const o = JSON.parse(raw) as { action?: string; view?: string };
    action = (o.action ?? "REPLY").toUpperCase();
    view = typeof o.view === "string" ? o.view.toLowerCase() : null;
  } catch {
    /* leave defaults */
  }
  return { action, view, raw };
}

function chatComposer(page: Page): Locator {
  return page.locator(CHAT_COMPOSER_SELECTOR).first();
}
async function sendChatCommand(page: Page, command: string): Promise<void> {
  await expect(chatComposer(page)).toBeVisible({ timeout: 60_000 });
  await chatComposer(page).fill(command);
  const send = page.locator(CHAT_SEND_SELECTOR).first();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(
    page
      .locator('[data-testid="chat-message"][data-role="user"]')
      .filter({ hasText: command })
      .last()
      .or(page.getByText(command).last()),
  ).toBeVisible({ timeout: 30_000 });
}
async function deliverAgentNavigate(
  page: Page,
  detail: Record<string, unknown>,
): Promise<void> {
  await page.evaluate((d) => {
    window.dispatchEvent(new CustomEvent("eliza:navigate:view", { detail: d }));
  }, detail);
}

interface CaseResult {
  utterance: string;
  kind: string;
  expected: string;
  decidedAction: string;
  decidedView: string | null;
  navigated: string | null;
  rendered: boolean;
  success: boolean;
  raw: string;
  chatImg: string;
  viewImg: string;
}

test.skip(
  !LIVE_LOCAL_MODEL,
  "requires ELIZA_UI_SMOKE_LOCAL_LLM_LIVE=1 and a real llama-server",
);

test("view switching driven by the local model — capture + report", async ({
  page,
}) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);

  const results: CaseResult[] = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const chatImg = `case-${i}-chat.png`;
    const viewImg = `case-${i}-view.png`;
    await openAppPath(page, "/chat");
    await sendChatCommand(page, c.utterance);
    await page.screenshot({ path: path.join(OUT, chatImg) });

    // Ask the LOCAL model what to do.
    let decision: ModelDecision = { action: "ERROR", view: null, raw: "" };
    try {
      decision = await decide(c.utterance);
    } catch (err) {
      decision.raw = String(err);
    }

    // Deliver the model's decision to the real renderer (only when it chose a
    // navigable VIEW). A REPLY / unknown view = no navigation (chat stays).
    let navigated: string | null = null;
    let rendered = false;
    const def = decision.view ? VIEW_REGISTRY[decision.view] : undefined;
    if (decision.action === "VIEWS" && def) {
      navigated = decision.view;
      await deliverAgentNavigate(page, {
        viewId: decision.view,
        viewPath: def.path,
        viewLabel: def.label,
        viewType: "gui",
        alwaysOnTop: false,
      });
      try {
        await expect(page).toHaveURL(
          new RegExp(
            `${def.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[?#]|$)`,
          ),
          { timeout: 15_000 },
        );
        if (def.onView) {
          await expect(def.onView(page)).toBeVisible({ timeout: 20_000 });
        }
        rendered = true;
      } catch {
        rendered = false;
      }
    }
    await page.screenshot({ path: path.join(OUT, viewImg) });

    const success =
      c.expected === ""
        ? decision.action !== "VIEWS"
        : decision.action === "VIEWS" &&
          decision.view === c.expected &&
          rendered;
    results.push({
      utterance: c.utterance,
      kind: c.kind,
      expected: c.expected,
      decidedAction: decision.action,
      decidedView: decision.view,
      navigated,
      rendered,
      success,
      raw: decision.raw,
      chatImg,
      viewImg,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[local-vs] "${c.utterance}" → ${decision.action}/${decision.view ?? "-"} (want ${c.expected || "REPLY"}) ${success ? "✓" : "✗"}`,
    );
  }

  writeReport(results);
  const passed = results.filter((r) => r.success).length;
  // eslint-disable-next-line no-console
  console.log(
    `\n[local-vs] ${MODEL_LABEL}: ${passed}/${results.length} correct → ${path.join(OUT, "report.html")}`,
  );
  expect(results.length).toBe(CASES.length);
  expect(results.every((r) => r.chatImg && r.viewImg)).toBe(true);
  const failures = results.filter((result) => !result.success);
  expect(
    failures,
    `local-model view switching failed ${failures.length}/${results.length} cases; inspect ${path.join(OUT, "report.html")}`,
  ).toEqual([]);
});

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function writeReport(results: CaseResult[]): void {
  const passed = results.filter((r) => r.success).length;
  writeFileSync(
    path.join(OUT, "results.json"),
    JSON.stringify(results, null, 2),
  );
  const rows = results
    .map((r) => {
      const ok = r.success;
      const badge = ok
        ? '<span style="color:#0a0;font-weight:700">✓ SUCCESS</span>'
        : '<span style="color:#c00;font-weight:700">✗ FAILURE</span>';
      const decided =
        r.decidedAction === "VIEWS"
          ? `VIEWS / ${esc(r.decidedView ?? "-")}`
          : esc(r.decidedAction);
      return `
      <tr style="border-top:2px solid ${ok ? "#0a0" : "#c00"}">
        <td>
          <div style="font-size:15px"><b>${esc(r.utterance)}</b></div>
          <div style="color:#888;font-size:12px">${esc(r.kind)}</div>
          <div style="margin-top:6px">${badge}</div>
          <table style="font-size:12px;color:#444;margin-top:6px">
            <tr><td>expected</td><td><b>${esc(r.expected || "REPLY (no nav)")}</b></td></tr>
            <tr><td>model said</td><td><b>${decided}</b></td></tr>
            <tr><td>navigated</td><td>${esc(r.navigated ?? "—")}</td></tr>
            <tr><td>view rendered</td><td>${r.rendered ? "yes" : "no"}</td></tr>
          </table>
          <pre style="font-size:11px;background:#f6f6f6;padding:6px;max-width:340px;white-space:pre-wrap">${esc(r.raw)}</pre>
        </td>
        <td><div style="font-size:11px;color:#888">chat (text going through)</div><img src="${r.chatImg}" style="width:420px;border:1px solid #ccc"></td>
        <td><div style="font-size:11px;color:#888">resulting view</div><img src="${r.viewImg}" style="width:420px;border:1px solid #ccc"></td>
      </tr>`;
    })
    .join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Local-model view switching e2e</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;background:#fff;color:#111}
h1{margin:0 0 4px}table{border-collapse:collapse}td{vertical-align:top;padding:8px}
.summary{font-size:18px;margin:8px 0 20px;padding:10px;background:#f0f0f0;border-radius:8px}</style></head>
<body>
<h1>View switching — local model e2e</h1>
<div style="color:#666">model: <b>${esc(MODEL_LABEL)}</b> via llama.cpp (${esc(LLAMACPP_URL)}) · schema-constrained planner · real chat composer → real renderer navigate</div>
<div class="summary"><b>${passed} / ${results.length}</b> correct — the local model's actual decision drives the real view switch. Failures show the wrong view (or no nav) it produced.</div>
<table><thead><tr><th>case</th><th>chat</th><th>view</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
  writeFileSync(path.join(OUT, "report.html"), html);
}
