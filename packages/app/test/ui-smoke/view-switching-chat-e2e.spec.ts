// End-to-end coverage for AGENT-DRIVEN VIEW SWITCHING: a chat command (ACTIVE
// navigation) or an intent-only message (PASSIVE routing) makes the renderer
// switch the active view.
//
// WHY THIS SPEC EXISTS (the gap it closes):
// The existing coverage proves the two halves of the view-switch seam in
// isolation but never the whole pipe end to end:
//   * scenario-runner (deterministic-view-switching) drives the REAL VIEWS
//     action but stops at the loopback navigate POST — it never renders a UI.
//   * The UI unit tests (app-navigate-view*, App.navigate-view-wiring,
//     startup-phase-hydrate.navigate-frame) synthesize the WS frame / DOM event
//     directly against a mocked App — they never run the real renderer shell.
// This spec joins them: it drives the REAL composer/send surface, then exercises
// the REAL renderer wiring — `client.onWsEvent("shell:navigate:view")` →
// `eliza:navigate:view` DOM event (startup-phase-hydrate.ts:431) →
// `createNavigateViewHandler` (app-navigate-view.ts) → `ViewRouter` +
// `useNavigationPathSync` (App.tsx) — and asserts the active view actually
// changed (URL + on-view marker).
//
// TWO TIERS (one always-on, one opt-in), so the spec is meaningful in CI and
// becomes a true black-box agent test when a provider key is present:
//
//   1. DETERMINISTIC tier (default lane — the keyless stub):
//      The stub returns a deterministic chat fixture but does NOT emit a
//      `shell:navigate:view` WS frame (see playwright-ui-smoke-api-stub.mjs
//      classifyAssistantAction — it only encodes the intended target as JSON
//      text). So we (a) send the real command through the composer to prove the
//      command surface, then (b) deterministically deliver the EXACT
//      `eliza:navigate:view` payload the renderer's WS handler emits for that
//      command — the precise normalized event from startup-phase-hydrate.ts:431
//      — and assert the renderer switched. This drives the entire renderer-side
//      navigate pipeline against the live app shell, not a mock.
//
//   2. LIVE tier (ELIZA_UI_SMOKE_LIVE_STACK=1 + provider key):
//      No synthetic dispatch. The real agent runs the VIEWS action, the backend
//      route broadcasts `shell:navigate:view` over the WS, and we assert the
//      renderer switched. This proves the full black-box chat → agent → VIEWS →
//      broadcast → renderer seam.
//
// NAVIGATION CONTRACT NOTES (verified against source, load-bearing for asserts):
//   * `/inbox`, `/calendar` are registered plugin views: tabFromPath() returns
//     "views" and ViewRouter mounts the dynamic bundle whose heading is the view
//     label ("Inbox" / "Calendar"). (navigation/index.ts:495, App.tsx
//     findRemoteViewForRoute)
//   * `/character/documents` maps to the built-in documents/knowledge subtab,
//     which embeds DocumentsView inside CharacterEditor.
//   * `/wallet` maps to the `inventory` tab (TAB_PATHS.inventory === "/wallet").
//   * `/settings` maps to the `settings` tab (settings-shell).
//   * `/task-coordinator` is the coding view (resolveIntentView maps app/feature
//     intent there). The PASSIVE coding case is asserted by URL — the
//     cross-mode-stable signal navigatePath() sets — to keep the deterministic
//     and live tiers identical.

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const CHAT_SEND_SELECTOR =
  '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]';
const VIEW_SWITCH_URL_TIMEOUT_MS = LIVE_STACK ? 90_000 : 30_000;

function calendarView(page: Page): Locator {
  return page.getByText("Design sync").first();
}

function inboxView(page: Page): Locator {
  return page.getByText(/Invoice #?42 overdue/i).first();
}

function todosView(page: Page): Locator {
  return page.getByText(/Today \(\d+\)/).first();
}

// The exact `eliza:navigate:view` detail the renderer's WS handler emits for a
// plain `show`/navigate frame (startup-phase-hydrate.ts:417-442): a navigate
// frame with no `action` and no `alwaysOnTop` normalizes to action:undefined,
// alwaysOnTop:false. We mirror that shape so the deterministic tier drives the
// renderer through the identical detail the live WS path would produce.
type NavigateViewDetail = {
  viewId?: string;
  viewPath?: string;
  viewLabel?: string;
  viewType?: "gui" | "tui" | "xr";
  action?: string;
  alwaysOnTop?: boolean;
};

type ViewSwitchCase = {
  /** Human label for the test name. */
  name: string;
  /** Navigation style under test. */
  kind: "active" | "passive";
  /** The chat utterance a user types (ACTIVE = explicit, PASSIVE = intent). */
  command: string;
  /** The view the agent resolves the command to. */
  view: {
    id: string;
    path: string;
    label: string;
  };
  /**
   * Expected URL pathname after the switch (regex-escaped exact match). The URL
   * is the cross-mode-stable assertion: it is set by `navigatePath()` in the
   * real `createNavigateViewHandler` and synced to the tab by
   * `useNavigationPathSync`.
   */
  expectedPath: string;
  /**
   * Optional on-view marker proving the renderer actually mounted the view (not
   * just changed the URL). Omitted for apps that mount a shared shell tab (e.g.
   * the chat surface) where the URL is the only honest assertion.
   */
  onView?: (page: Page) => Locator;
};

type ApiViewSummary = {
  id?: string;
  path?: string;
  viewType?: string;
};

type ApiViewsResponse = {
  views?: ApiViewSummary[];
};

type ApiConversationResponse = {
  conversation?: {
    id?: string;
  };
};

const VIEW_SWITCH_CASES: readonly ViewSwitchCase[] = [
  {
    name: 'ACTIVE: "go to my email" opens the inbox/email view',
    kind: "active",
    command: "go to my email",
    view: { id: "inbox", path: "/inbox", label: "Inbox" },
    expectedPath: "/inbox",
    onView: inboxView,
  },
  {
    name: 'ACTIVE: "open settings" opens the settings view',
    kind: "active",
    command: "open settings",
    view: { id: "settings", path: "/settings", label: "Settings" },
    expectedPath: "/settings",
    onView: (page) => page.getByTestId("settings-shell").first(),
  },
  {
    name: 'ACTIVE: "show my wallet" opens the wallet/inventory view',
    kind: "active",
    command: "show my wallet",
    view: { id: "wallet", path: "/wallet", label: "Wallet" },
    expectedPath: "/wallet",
    onView: (page) =>
      page
        .getByTestId("wallet-shell")
        .first()
        .or(page.getByRole("heading", { name: "Wallet" }).first()),
  },
  {
    name: 'PASSIVE: "what\'s on my calendar" opens the calendar view',
    kind: "passive",
    command: "what's on my calendar this week",
    view: { id: "calendar", path: "/calendar", label: "Calendar" },
    expectedPath: "/calendar",
    // The registered calendar view (CalendarView.tsx) marks its container with
    // stable period controls and agenda text rather than a literal heading.
    onView: calendarView,
  },
  {
    name: 'PASSIVE: "check my messages" opens the inbox',
    kind: "passive",
    command: "check my messages",
    view: { id: "inbox", path: "/inbox", label: "Inbox" },
    expectedPath: "/inbox",
    onView: inboxView,
  },
  {
    name: 'PASSIVE: "I want to add a new feature to my app" opens the coding (task-coordinator) view',
    kind: "passive",
    command: "I want to add a new feature to my app",
    view: {
      id: "task-coordinator",
      path: "/task-coordinator",
      label: "Task Coordinator",
    },
    // The coding view is task-coordinator (resolveIntentView maps app/feature
    // intent there). URL is the cross-mode-stable assertion; no separate testid
    // is asserted so the deterministic + live tiers stay identical.
    expectedPath: "/task-coordinator",
  },
  {
    name: 'PASSIVE: "show my documents" opens the Knowledge/Documents view',
    kind: "passive",
    command: "show my documents",
    view: {
      id: "documents",
      path: "/character/documents",
      label: "Knowledge",
    },
    expectedPath: "/character/documents",
    onView: (page) => page.getByTestId("documents-view").first(),
  },
  // --- Multilingual: the same navigate→render pipeline (deterministic tier) and
  // real-LLM routing (live tier) must work for non-English utterances. ---
  {
    name: 'PASSIVE (es): "muéstrame mi calendario" opens the calendar view',
    kind: "passive",
    command: "muéstrame mi calendario",
    view: { id: "calendar", path: "/calendar", label: "Calendar" },
    expectedPath: "/calendar",
    // The registered calendar view (CalendarView.tsx) marks its container with
    // stable period controls and agenda text rather than a literal heading.
    onView: calendarView,
  },
  {
    name: 'ACTIVE (fr): "montre-moi mon portefeuille" opens the wallet view',
    kind: "active",
    command: "montre-moi mon portefeuille",
    view: { id: "wallet", path: "/wallet", label: "Wallet" },
    expectedPath: "/wallet",
    onView: (page) =>
      page
        .getByTestId("wallet-shell")
        .first()
        .or(page.getByRole("heading", { name: "Wallet" }).first()),
  },
  {
    name: 'PASSIVE (es): "revisa mi correo" opens the inbox',
    kind: "passive",
    command: "revisa mi correo",
    view: { id: "inbox", path: "/inbox", label: "Inbox" },
    expectedPath: "/inbox",
    onView: inboxView,
  },
  {
    name: 'PASSIVE (zh): "我的待办事项" opens the todos view',
    kind: "passive",
    command: "我的待办事项",
    view: { id: "todos", path: "/todos", label: "Todos" },
    expectedPath: "/todos",
    onView: todosView,
  },
  // --- Wider language matrix (deterministic tier): the navigate→render pipeline
  // must hold for the full set of matcher languages, not just the es/fr/zh
  // samples above. Each command is a curated, fully-in-language phrase lifted
  // verbatim from CURATED_MULTILINGUAL (plugin-app-control view-matrix.fixtures),
  // where view-matrix.test.ts proves resolveIntentView(phrase) === viewId for all
  // 10 languages — so the live tier's real-LLM routing is exercised by the same
  // phrases the deterministic resolver is asserted to land. calendar + wallet are
  // covered here for pt/de/ja/ko/vi/tl (es/fr/zh already sampled above).
  {
    name: 'ACTIVE (pt): "abra meu calendário" opens the calendar view',
    kind: "active",
    command: "abra meu calendário",
    view: { id: "calendar", path: "/calendar", label: "Calendar" },
    expectedPath: "/calendar",
    onView: calendarView,
  },
  {
    name: 'ACTIVE (de): "öffne meinen kalender" opens the calendar view',
    kind: "active",
    command: "öffne meinen kalender",
    view: { id: "calendar", path: "/calendar", label: "Calendar" },
    expectedPath: "/calendar",
    onView: calendarView,
  },
  {
    name: 'ACTIVE (ja): "カレンダーを開いて" opens the calendar view',
    kind: "active",
    command: "カレンダーを開いて",
    view: { id: "calendar", path: "/calendar", label: "Calendar" },
    expectedPath: "/calendar",
    onView: calendarView,
  },
  {
    name: 'ACTIVE (ko): "캘린더 열어" opens the calendar view',
    kind: "active",
    command: "캘린더 열어",
    view: { id: "calendar", path: "/calendar", label: "Calendar" },
    expectedPath: "/calendar",
    onView: calendarView,
  },
  {
    name: 'ACTIVE (vi): "mở lịch" opens the calendar view',
    kind: "active",
    command: "mở lịch",
    view: { id: "calendar", path: "/calendar", label: "Calendar" },
    expectedPath: "/calendar",
    onView: calendarView,
  },
  {
    name: 'ACTIVE (tl): "buksan ang calendar" opens the calendar view',
    kind: "active",
    command: "buksan ang calendar",
    view: { id: "calendar", path: "/calendar", label: "Calendar" },
    expectedPath: "/calendar",
    onView: calendarView,
  },
  {
    name: 'ACTIVE (pt): "abra minha carteira" opens the wallet view',
    kind: "active",
    command: "abra minha carteira",
    view: { id: "wallet", path: "/wallet", label: "Wallet" },
    expectedPath: "/wallet",
    onView: (page) =>
      page
        .getByTestId("wallet-shell")
        .first()
        .or(page.getByRole("heading", { name: "Wallet" }).first()),
  },
  {
    name: 'ACTIVE (de): "öffne meine brieftasche" opens the wallet view',
    kind: "active",
    command: "öffne meine brieftasche",
    view: { id: "wallet", path: "/wallet", label: "Wallet" },
    expectedPath: "/wallet",
    onView: (page) =>
      page
        .getByTestId("wallet-shell")
        .first()
        .or(page.getByRole("heading", { name: "Wallet" }).first()),
  },
  {
    name: 'ACTIVE (ja): "ウォレットを開いて" opens the wallet view',
    kind: "active",
    command: "ウォレットを開いて",
    view: { id: "wallet", path: "/wallet", label: "Wallet" },
    expectedPath: "/wallet",
    onView: (page) =>
      page
        .getByTestId("wallet-shell")
        .first()
        .or(page.getByRole("heading", { name: "Wallet" }).first()),
  },
  {
    name: 'ACTIVE (ko): "지갑 열어" opens the wallet view',
    kind: "active",
    command: "지갑 열어",
    view: { id: "wallet", path: "/wallet", label: "Wallet" },
    expectedPath: "/wallet",
    onView: (page) =>
      page
        .getByTestId("wallet-shell")
        .first()
        .or(page.getByRole("heading", { name: "Wallet" }).first()),
  },
  {
    name: 'ACTIVE (vi): "mở ví" opens the wallet view',
    kind: "active",
    command: "mở ví",
    view: { id: "wallet", path: "/wallet", label: "Wallet" },
    expectedPath: "/wallet",
    onView: (page) =>
      page
        .getByTestId("wallet-shell")
        .first()
        .or(page.getByRole("heading", { name: "Wallet" }).first()),
  },
  {
    name: 'ACTIVE (tl): "buksan ang wallet" opens the wallet view',
    kind: "active",
    command: "buksan ang wallet",
    view: { id: "wallet", path: "/wallet", label: "Wallet" },
    expectedPath: "/wallet",
    onView: (page) =>
      page
        .getByTestId("wallet-shell")
        .first()
        .or(page.getByRole("heading", { name: "Wallet" }).first()),
  },
];

function chatComposer(page: Page): Locator {
  return page.locator(CHAT_COMPOSER_SELECTOR).first();
}

function chatSendButton(page: Page): Locator {
  return page.locator(CHAT_SEND_SELECTOR).first();
}

function userMessage(page: Page, text: string): Locator {
  return page
    .locator('[data-testid="chat-message"][data-role="user"]')
    .filter({ hasText: text })
    .last()
    .or(
      page
        .getByRole("region", { name: /conversation history/i })
        .getByText(text)
        .last(),
    )
    .first();
}

/** Send a chat command through the real composer + send button. */
async function sendChatCommand(
  page: Page,
  command: string,
  expectedPath?: string,
): Promise<void> {
  await expect(chatComposer(page)).toBeVisible({ timeout: 60_000 });
  await chatComposer(page).fill(command);
  await expect(chatSendButton(page)).toBeEnabled();
  await chatSendButton(page).click();
  // In the deterministic lane, the app cannot navigate until this spec
  // dispatches the synthetic navigate event below, so the user turn must render
  // in chat. In the live lane, a fast VIEWS action may switch away from chat
  // before the chat log assertion observes the user bubble; the expected URL is
  // equivalent proof that the command entered the chat -> agent -> view pipe.
  if (LIVE_STACK && expectedPath) {
    await expect
      .poll(
        async () => {
          if (expectedPathRegExp(expectedPath).test(page.url())) {
            return "view";
          }
          if (
            await userMessage(page, command)
              .isVisible()
              .catch(() => false)
          ) {
            return "message";
          }
          return "";
        },
        {
          timeout: 30_000,
          message:
            "Expected the sent chat command to render or navigate the live app.",
        },
      )
      .not.toBe("");
    return;
  }

  // The user turn must render — proves the command actually entered the
  // chat/message pipeline (not just sat in the textarea).
  await expect(userMessage(page, command)).toBeVisible({ timeout: 30_000 });
}

/**
 * Deterministically deliver the SAME `eliza:navigate:view` event the renderer's
 * `client.onWsEvent("shell:navigate:view")` handler dispatches for a plain
 * navigate (startup-phase-hydrate.ts:431). In the live lane the real agent emits
 * the WS frame, so we never call this.
 */
async function deliverAgentNavigate(
  page: Page,
  detail: NavigateViewDetail,
): Promise<void> {
  await page.evaluate((navDetail) => {
    window.dispatchEvent(
      new CustomEvent("eliza:navigate:view", { detail: navDetail }),
    );
  }, detail);
}

async function assertViewSwitched(
  page: Page,
  testCase: ViewSwitchCase,
): Promise<void> {
  await expect(page).toHaveURL(expectedPathRegExp(testCase.expectedPath), {
    timeout: VIEW_SWITCH_URL_TIMEOUT_MS,
  });
  if (testCase.onView) {
    await expect(testCase.onView(page)).toBeVisible({ timeout: 60_000 });
  }
}

function expectedPathRegExp(expectedPath: string): RegExp {
  return new RegExp(`${escapeForRegExp(expectedPath)}(?:[?#]|$)`);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function liveRegisteredViewIds(page: Page): Promise<Set<string>> {
  const response = await page.request.get("/api/views");
  expect(response.ok(), "live runtime should expose /api/views").toBe(true);
  const body = (await response.json()) as ApiViewsResponse;
  return new Set(
    (body.views ?? [])
      .map((view) => (typeof view.id === "string" ? view.id : ""))
      .filter(Boolean),
  );
}

async function ensureLiveViewRegisteredForCase(
  page: Page,
  testCase: ViewSwitchCase,
): Promise<void> {
  if (!LIVE_STACK) return;

  const registeredViewIds = await liveRegisteredViewIds(page);
  test.skip(
    !registeredViewIds.has(testCase.view.id),
    `live runtime did not register view "${testCase.view.id}"`,
  );
}

async function createAndActivateLiveConversationForCase(
  page: Page,
  testCase: ViewSwitchCase,
): Promise<void> {
  if (!LIVE_STACK) return;

  const response = await page.evaluate(
    async (payload) => {
      const createResponse = await fetch("/api/conversations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return {
        ok: createResponse.ok,
        status: createResponse.status,
        text: await createResponse.text(),
      };
    },
    {
      title: `view-switch: ${testCase.view.id}`,
    },
  );
  expect(
    response.ok,
    `live runtime should create an isolated chat (status=${response.status}, body=${response.text.slice(0, 500)})`,
  ).toBe(true);
  const body = JSON.parse(response.text) as ApiConversationResponse;
  const conversationId = body.conversation?.id?.trim();
  expect(conversationId, "created live conversation id").toBeTruthy();

  await page.evaluate((id) => {
    localStorage.setItem("eliza:chat:activeConversationId", id);
  }, conversationId);
  await openAppPath(page, "/chat");
  await expect(chatComposer(page)).toBeVisible({ timeout: 60_000 });
}

test.beforeEach(async ({ page }) => {
  // Land on the chat surface in the full-shell mode so the composer is present
  // and the navigate handler runs against the real ViewRouter.
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

for (const testCase of VIEW_SWITCH_CASES) {
  test(testCase.name, async ({ page }) => {
    await ensureLiveViewRegisteredForCase(page, testCase);
    await openAppPath(page, "/chat");
    await createAndActivateLiveConversationForCase(page, testCase);

    // 1) Drive the real command surface: type + send the user's message.
    await sendChatCommand(page, testCase.command, testCase.expectedPath);

    // 2) Reach the navigate. Live: the real agent broadcasts shell:navigate:view
    //    and the renderer switches on its own. Deterministic: the stub does not
    //    broadcast a navigate frame, so we deliver the exact event the renderer's
    //    WS handler would emit for the agent's resolved view — exercising the
    //    real createNavigateViewHandler + ViewRouter pipeline.
    if (!LIVE_STACK) {
      await deliverAgentNavigate(page, {
        viewId: testCase.view.id,
        viewPath: testCase.view.path,
        viewLabel: testCase.view.label,
        viewType: "gui",
        action: undefined,
        alwaysOnTop: false,
      });
    }

    // 3) Assert the renderer actually switched the active view.
    await assertViewSwitched(page, testCase);
  });
}

// Regression guard for the navigate-event normalization contract the renderer
// relies on: a raw agent navigate (viewId only, no viewPath) must still resolve
// to `/apps/<viewId>` via pathForNavigateViewDetail(). This is the fallback path
// the live agent uses when it sends only a view id. Runs in both tiers because
// it dispatches the same DOM event the WS handler emits.
test("agent navigate by viewId-only resolves to /apps/<viewId>", async ({
  page,
}) => {
  test.skip(
    LIVE_STACK,
    "viewId-only fallback is a renderer-normalization guard; the live agent path is covered by the cases above",
  );
  await openAppPath(page, "/chat");
  await sendChatCommand(page, "open the model tester");

  await deliverAgentNavigate(page, {
    viewId: "model-tester",
    viewType: "gui",
    action: undefined,
    alwaysOnTop: false,
  });

  await expect(page).toHaveURL(/\/apps\/model-tester(?:[?#]|$)/, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("model-tester-shell").first()).toBeVisible({
    timeout: 60_000,
  });
});

// Guard: an explicit ACTIVE close command must tear the view down and return to
// chat — the close branch of createNavigateViewHandler (app-navigate-view.ts:113)
// is otherwise only unit-tested. Deterministic-only (the close frame shape is
// renderer-contract, not agent-behavior).
test("agent close-view navigate returns to chat", async ({ page }) => {
  test.skip(LIVE_STACK, "close-frame teardown is a renderer-contract guard");
  await openAppPath(page, "/chat");
  // `eliza:navigate:view` is a one-shot DOM event with no queue; its listener is
  // attached in a post-paint App effect (App.tsx). The interactive chat shell
  // (composer visible) is the proof that effect has committed — the other cases
  // implicitly wait for it via sendChatCommand. Without this wait, dispatching
  // the navigate ~1.5s after load races the listener attach and the event is
  // dropped, leaving the URL on /chat.
  await expect(chatComposer(page)).toBeVisible({ timeout: 60_000 });

  // Open a view first.
  await deliverAgentNavigate(page, {
    viewId: "inbox",
    viewPath: "/inbox",
    viewLabel: "Inbox",
    viewType: "gui",
    action: undefined,
    alwaysOnTop: false,
  });
  await expect(page).toHaveURL(/\/inbox(?:[?#]|$)/, { timeout: 30_000 });

  // Close it.
  await deliverAgentNavigate(page, { action: "close", viewId: "inbox" });

  // The chat composer is the proof we returned to the chat surface.
  await expect(chatComposer(page)).toBeVisible({ timeout: 30_000 });
});

test("agent split-view navigate renders documents and calendar layout", async ({
  page,
}) => {
  test.skip(
    LIVE_STACK,
    "split-layout resolution is covered by VIEWS action tests; this guards the renderer contract",
  );
  await openAppPath(page, "/chat");
  await sendChatCommand(page, "split documents and calendar side by side");

  await deliverAgentNavigate(page, {
    action: "split-view",
    viewId: "documents",
    viewPath: "/character/documents",
    viewLabel: "Knowledge",
    viewType: "gui",
    views: ["documents", "calendar"],
    layout: "horizontal",
  });

  await expect(page).toHaveURL(/\/views(?:[?#]|$)/, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("view-layout-surface")).toBeVisible({
    timeout: 60_000,
  });
  const documentsPane = page.getByTestId("view-layout-pane-documents");
  const calendarPane = page.getByTestId("view-layout-pane-calendar");
  await expect(documentsPane).toBeVisible({
    timeout: 30_000,
  });
  await expect(calendarPane).toBeVisible({
    timeout: 30_000,
  });
  await expect(documentsPane.getByTestId("documents-view")).toBeVisible({
    timeout: 30_000,
  });
  await expect(calendarPane.getByText("Design sync").first()).toBeVisible({
    timeout: 30_000,
  });
});
