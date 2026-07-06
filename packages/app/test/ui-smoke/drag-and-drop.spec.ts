/**
 * Real-gesture drag-and-drop harness (#10722).
 *
 * Every user-facing DnD surface in the shipped app, driven with REAL input —
 * `mouse.down` → staged multi-step `mouse.move` → `mouse.up` for the
 * pointer/HTML5-draggable surfaces (Chromium's native drag loop runs via
 * Playwright's CDP drag interception), and a REAL `DataTransfer` carrying REAL
 * `File` bytes for the file-drop zones (an OS-level file drag cannot originate
 * inside the renderer, so the genuine DataTransfer is the strongest possible
 * gesture: everything from the listener down is the real product pipeline).
 *
 * Surface inventory (ranked by user impact — see the evidence README):
 *   1. Plugin list custom ordering (/apps/plugins) — HTML5 draggable rows,
 *      persisted to localStorage["pluginOrder"], survives reload.
 *   2. Chat overlay file drop (/chat) — dropped files feed the SAME intake
 *      pipeline as paste/attach (addImageFiles → pending strip → stream POST).
 *   3. Knowledge view file drop (/character/documents) — HTML5 file drop on
 *      the view root; files read + encoded in the renderer and POSTed to
 *      /api/documents/bulk. (The old UploadZone drop fieldset is unmounted in
 *      the shipped app — see the finding note at the describe block.)
 *   4. Launcher (/views) — CURATED in production: pageGroups are supplied, so
 *      edit-mode reorder is disabled by design. Locked in as a contract test.
 *
 * Outcome assertions are the point: persisted order re-asserted after reload,
 * dropped bytes asserted inside the outbound API payload, cancels and invalid
 * drops asserted as no-ops, and a rapid-successive-drag invariant.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  readLocalStorage,
  seedAppStorage,
} from "./helpers";
import {
  dropFilesOn,
  fileDataTransfer,
  hoverThenLeaveFiles,
  realMouseDrag,
  textDataTransfer,
} from "./helpers/dnd-gestures";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

// Capture artifacts land under the repo-level test-results tree; the suite cwd
// is packages/app, so a bare process.cwd() would nest a stray output tree there.
const REPO_ROOT = process.cwd().endsWith(path.join("packages", "app"))
  ? path.resolve(process.cwd(), "..", "..")
  : process.cwd();
const OUT_DIR = path.join(
  REPO_ROOT,
  "test-results",
  "ui-smoke-artifacts",
  "10722-dnd-harness",
);

async function evidenceShot(page: Page, name: string): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(OUT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 3,
  });
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Surface 1 — plugin list custom ordering (/apps/plugins).
 * HTML5 draggable <li data-plugin-id> rows; drop splices the id into
 * localStorage["pluginOrder"]; sortPlugins re-derives the render order from it
 * on every mount, so the arrangement survives reload.
 * ──────────────────────────────────────────────────────────────────────────── */

const DND_PLUGIN_WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
] as const;

const DND_PLUGINS = DND_PLUGIN_WORDS.map((word, index) => ({
  id: `dnd-${word}`,
  name: `DnD ${word[0].toUpperCase()}${word.slice(1)}`,
  description: `Deterministic drag fixture plugin ${word}.`,
  tags: ["feature"],
  enabled: index % 2 === 0,
  configured: true,
  envKey: null,
  category: "feature",
  source: "bundled",
  parameters: [],
  validationErrors: [],
  validationWarnings: [],
  isActive: index % 2 === 0,
}));

async function installPluginFixture(page: Page): Promise<void> {
  await page.route("**/api/plugins", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plugins: DND_PLUGINS }),
    });
  });
}

function pluginRow(page: Page, id: string) {
  return page.locator(`li[data-plugin-id="${id}"]`);
}

async function pluginRowOrder(page: Page): Promise<string[]> {
  return page
    .locator('li[data-plugin-id^="dnd-"]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute("data-plugin-id") ?? "")
        .filter(Boolean),
    );
}

/** Mirrors PluginsView.handleDrop splice semantics (toIdx read pre-removal). */
function expectedAfterDrop(
  ids: string[],
  srcId: string,
  targetId: string,
): string[] {
  const next = [...ids];
  const fromIdx = next.indexOf(srcId);
  const toIdx = next.indexOf(targetId);
  next.splice(fromIdx, 1);
  next.splice(toIdx, 0, srcId);
  return next;
}

async function openPluginsList(page: Page): Promise<string[]> {
  await openAppPath(page, "/apps/plugins");
  await expect(page.locator('li[data-plugin-id^="dnd-"]').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('li[data-plugin-id^="dnd-"]')).toHaveCount(
    DND_PLUGINS.length,
    { timeout: 15_000 },
  );
  return pluginRowOrder(page);
}

test.describe("plugin list custom order — real-mouse HTML5 drag", () => {
  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await installPluginFixture(page);
  });

  test("drag reorders the list, persists to pluginOrder, and survives reload", async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    const initial = await openPluginsList(page);
    expect(initial).toHaveLength(DND_PLUGINS.length);
    await evidenceShot(page, "plugins-01-before-drag");

    const srcId = initial[0];
    const targetId = initial[2];
    const expected = expectedAfterDrop(initial, srcId, targetId);

    await realMouseDrag(
      page,
      pluginRow(page, srcId),
      pluginRow(page, targetId),
    );

    await expect
      .poll(() => pluginRowOrder(page), {
        message: "DOM row order must reflect the drop splice",
        timeout: 10_000,
      })
      .toEqual(expected);
    await evidenceShot(page, "plugins-02-after-drag");

    // Persistence side-effect: the custom order landed in localStorage.
    const storedRaw = await readLocalStorage(page, "pluginOrder");
    expect(storedRaw, "pluginOrder must be written after a drop").toBeTruthy();
    const stored = JSON.parse(storedRaw ?? "[]") as string[];
    expect(stored.filter((id) => id.startsWith("dnd-"))).toEqual(expected);

    // Reload → the arrangement is re-derived from the persisted order.
    const afterReload = await openPluginsList(page);
    expect(afterReload).toEqual(expected);
    await evidenceShot(page, "plugins-03-after-reload");

    expect(pageErrors).toEqual([]);
  });

  test("dropping on an invalid target (section heading) is a no-op and clears drag styling", async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    const initial = await openPluginsList(page);

    const heading = page
      .getByRole("heading", { name: "Other Features" })
      .first();
    await expect(heading).toBeVisible();
    const headingBox = await heading.boundingBox();
    if (!headingBox) throw new Error("section heading has no layout box");

    // Real drag that ENTERS a valid row (its dragover highlight engages) but
    // releases over the section heading — no drop target, so the native drag
    // ends with dragend and no drop.
    await realMouseDrag(
      page,
      pluginRow(page, initial[3]),
      pluginRow(page, initial[1]),
      {
        releaseAt: {
          x: headingBox.x + headingBox.width / 2,
          y: headingBox.y + headingBox.height / 2,
        },
      },
    );

    expect(await pluginRowOrder(page)).toEqual(initial);
    // onDragEnd cleanup: no row may be stuck with the mid-drag opacity style.
    await expect(
      page.locator('li[data-plugin-id^="dnd-"].opacity-30'),
    ).toHaveCount(0);
    expect(await readLocalStorage(page, "pluginOrder")).toBeNull();
    await evidenceShot(page, "plugins-04-invalid-drop-noop");
    expect(pageErrors).toEqual([]);
  });

  test("Escape mid-drag cancels — original order restored, nothing persisted", async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    const initial = await openPluginsList(page);

    const heading = page
      .getByRole("heading", { name: "Other Features" })
      .first();
    const headingBox = await heading.boundingBox();
    if (!headingBox) throw new Error("section heading has no layout box");

    // Escape is pressed while hovering a valid drop row. NOTE: a native
    // (human) Escape cancels the HTML5 drag session at the browser level —
    // dragend fires with no drop. Under Playwright's CDP drag interception the
    // keyboard is not routed into the drag controller, so the deterministic
    // cancel signal we can drive end-to-end is the same product-visible event
    // sequence the browser produces for Escape: dragstart → dragover(s) →
    // dragend with NO drop (release away from any droppable row). Both paths
    // are asserted here: Escape pressed for real, then the no-drop release.
    await realMouseDrag(
      page,
      pluginRow(page, initial[4]),
      pluginRow(page, initial[0]),
      {
        escapeBeforeRelease: true,
        releaseAt: {
          x: headingBox.x + headingBox.width / 2,
          y: headingBox.y + headingBox.height / 2,
        },
      },
    );

    expect(await pluginRowOrder(page)).toEqual(initial);
    await expect(
      page.locator('li[data-plugin-id^="dnd-"].opacity-30'),
    ).toHaveCount(0);
    expect(await readLocalStorage(page, "pluginOrder")).toBeNull();

    // The canceled drag must not poison the next one: a normal drag after the
    // cancel still reorders.
    const expected = expectedAfterDrop(initial, initial[0], initial[1]);
    await realMouseDrag(
      page,
      pluginRow(page, initial[0]),
      pluginRow(page, initial[1]),
    );
    await expect
      .poll(() => pluginRowOrder(page), { timeout: 10_000 })
      .toEqual(expected);
    expect(pageErrors).toEqual([]);
  });

  test("rapid successive drags keep the list consistent (no lost/duplicated rows)", async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    const initial = await openPluginsList(page);

    // Three back-to-back drags with minimal hover pauses and no settle waits
    // between them — the concurrency edge a fast human produces.
    await realMouseDrag(
      page,
      pluginRow(page, initial[0]),
      pluginRow(page, initial[5]),
      { hoverPauseMs: 30, pathSegments: 5 },
    );
    await realMouseDrag(
      page,
      pluginRow(page, initial[2]),
      pluginRow(page, initial[0]),
      { hoverPauseMs: 30, pathSegments: 5 },
    );
    await realMouseDrag(
      page,
      pluginRow(page, initial[4]),
      pluginRow(page, initial[1]),
      { hoverPauseMs: 30, pathSegments: 5 },
    );

    // Invariant: the list is a permutation — every row exactly once.
    const finalOrder = await pluginRowOrder(page);
    expect([...finalOrder].sort()).toEqual([...initial].sort());

    // Persisted order converges to exactly what the DOM shows.
    await expect
      .poll(
        async () => {
          const raw = await readLocalStorage(page, "pluginOrder");
          const stored = (JSON.parse(raw ?? "[]") as string[]).filter((id) =>
            id.startsWith("dnd-"),
          );
          return stored;
        },
        {
          message: "localStorage pluginOrder must match the rendered order",
          timeout: 10_000,
        },
      )
      .toEqual(finalOrder);

    // And a reload renders that same converged order.
    const afterReload = await openPluginsList(page);
    expect(afterReload).toEqual(finalOrder);
    await evidenceShot(page, "plugins-05-rapid-drags-converged");
    expect(pageErrors).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Surface 2 — chat overlay file drop (/chat).
 * Dropped files run the SAME intake pipeline as paste/attach: pending
 * thumbnail strip → send → base64 payload inside the outbound stream POST.
 * ──────────────────────────────────────────────────────────────────────────── */

const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type StreamCall = { text?: string; images?: unknown };

async function installChatConversationMock(page: Page): Promise<{
  streamCalls: () => StreamCall[];
}> {
  const streamCalls: StreamCall[] = [];
  let created = false;
  const conversationId = "dnd-conversation";
  const timestampOf = () => new Date().toISOString();
  const conversationBody = () => ({
    id: conversationId,
    roomId: "dnd-room",
    title: "DnD smoke",
    createdAt: timestampOf(),
    updatedAt: timestampOf(),
  });

  await page.route("**/api/conversations", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversations: created ? [conversationBody()] : [],
        }),
      });
      return;
    }
    if (method === "POST") {
      created = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation: conversationBody() }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(`**/api/conversations/${conversationId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation: conversationBody() }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    `**/api/conversations/${conversationId}/messages`,
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages: [] }),
        });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    `**/api/conversations/${conversationId}/greeting**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          text: "Ready when you are.",
          localInference: null,
        }),
      });
    },
  );

  await page.route(
    `**/api/conversations/${conversationId}/messages/stream`,
    async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as StreamCall;
      streamCalls.push(body);
      const assistantText = "Got the drop.";
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({
            type: "token",
            text: assistantText,
            fullText: assistantText,
          })}\n\n` +
          `data: ${JSON.stringify({
            type: "done",
            fullText: assistantText,
            agentName: "Eliza",
          })}\n\n`,
      });
    },
  );

  return { streamCalls: () => [...streamCalls] };
}

test.describe("chat overlay — real DataTransfer file drop", () => {
  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
  });

  test("dropping a PNG attaches it: pending thumbnail, then base64 payload in the stream POST", async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    const conversations = await installChatConversationMock(page);

    await openAppPath(page, "/chat");
    await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
      timeout: 60_000,
    });
    const chatContent = page.getByTestId("chat-content");
    await expect(chatContent).toBeVisible({ timeout: 15_000 });

    const dt = await fileDataTransfer(page, [
      {
        name: "dropped.png",
        mimeType: "image/png",
        base64: ONE_PX_PNG.toString("base64"),
      },
    ]);
    await dropFilesOn(chatContent, dt);

    // The dropped file lands in the SAME pending-attachment strip that paste
    // and the attach button feed (alt = file name).
    const pendingThumb = page.locator('img[alt="dropped.png"]');
    await expect(pendingThumb).toBeVisible({ timeout: 10_000 });
    await evidenceShot(page, "chat-01-dropped-pending-thumbnail");

    const composer = page
      .locator(
        '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]',
      )
      .first();
    await composer.fill("what did I just drop?");
    const send = page.getByTestId("chat-composer-action");
    await expect(send).toBeVisible({ timeout: 10_000 });
    await send.click();

    // The outbound stream POST carries the dropped bytes, base64-encoded —
    // the real ingestion contract of the chat surface.
    await expect
      .poll(() => conversations.streamCalls().length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const lastCall = conversations.streamCalls().at(-1);
    expect(lastCall?.text).toBe("what did I just drop?");
    const images = (lastCall?.images ?? []) as Array<{
      data?: string;
      mimeType?: string;
      name?: string;
    }>;
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual(
      expect.objectContaining({
        mimeType: "image/png",
        name: "dropped.png",
        data: ONE_PX_PNG.toString("base64"),
      }),
    );

    // Send clears the pending strip.
    await expect(pendingThumb).toHaveCount(0, { timeout: 10_000 });
    await evidenceShot(page, "chat-02-sent-after-drop");
    expect(pageErrors).toEqual([]);
  });

  test("non-file drags and aborted hovers are no-ops on the chat surface", async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    await installChatConversationMock(page);

    await openAppPath(page, "/chat");
    const chatContent = page.getByTestId("chat-content");
    await expect(chatContent).toBeVisible({ timeout: 60_000 });

    // A text-selection drag (no Files entry) must not be claimed: the overlay
    // ignores it, no attachment appears, no error surfaces.
    const textDt = await textDataTransfer(page);
    await dropFilesOn(chatContent, textDt);
    await page.waitForTimeout(500);
    await expect(page.locator('img[alt="dropped.png"]')).toHaveCount(0);

    // Hover-then-leave with a real file: no drop happened, so nothing attaches.
    const fileDt = await fileDataTransfer(page, [
      {
        name: "never-dropped.png",
        mimeType: "image/png",
        base64: ONE_PX_PNG.toString("base64"),
      },
    ]);
    await hoverThenLeaveFiles(chatContent, fileDt);
    await page.waitForTimeout(500);
    await expect(page.locator('img[alt="never-dropped.png"]')).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Surface 3 — knowledge view file drop (/character/documents).
 * HTML5 file drop; the renderer reads the file, encodes it, and POSTs
 * /api/documents/bulk; the list refresh then shows the ingested document.
 * The bulk endpoint here is a stateful in-page fixture (the keyless smoke
 * stack has no document-ingestion backend); the entire renderer pipeline —
 * DataTransfer → FileReader → payload encode → POST → list refetch → render —
 * is the real product path, and the posted bytes are asserted verbatim.
 * ──────────────────────────────────────────────────────────────────────────── */

interface StoredDoc {
  id: string;
  filename: string;
  contentType: string;
  fileSize: number;
  createdAt: number;
  fragmentCount: number;
  source: string;
  scope: string;
  provenance: { kind: string; label: string };
  canEditText: boolean;
  canDelete: boolean;
  content: { text: string };
}

interface BulkUploadBody {
  documents?: Array<{
    content?: string;
    filename?: string;
    contentType?: string;
    scope?: string;
    metadata?: { includeImageDescriptions?: boolean };
  }>;
}

async function installStatefulDocumentsApi(page: Page): Promise<{
  bulkCalls: () => BulkUploadBody[];
}> {
  const docs: StoredDoc[] = [];
  const bulkCalls: BulkUploadBody[] = [];

  await page.route("**/api/documents/bulk", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = JSON.parse(
      route.request().postData() ?? "{}",
    ) as BulkUploadBody;
    bulkCalls.push(body);
    const results = (body.documents ?? []).map((doc, index) => {
      const id = `dnd-doc-${docs.length + 1}`;
      docs.push({
        id,
        filename: doc.filename ?? "unnamed",
        contentType: doc.contentType ?? "application/octet-stream",
        fileSize: doc.content?.length ?? 0,
        createdAt: Date.now(),
        fragmentCount: 1,
        source: "upload",
        scope: doc.scope ?? "user-private",
        provenance: { kind: "upload", label: "Manual upload" },
        canEditText: true,
        canDelete: true,
        content: { text: doc.content ?? "" },
      });
      return {
        index,
        ok: true,
        filename: doc.filename ?? "unnamed",
        documentId: id,
        fragmentCount: 1,
      };
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        total: results.length,
        successCount: results.length,
        failureCount: 0,
        results,
      }),
    });
  });

  // Registered AFTER installDefaultAppRoutes so this stateful handler takes
  // precedence over the static populated fixtures (newest route wins).
  await page.route("**/api/documents**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    if (pathname === "/api/documents") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          available: true,
          agentId: "ui-smoke-agent",
          documents: docs,
          total: docs.length,
          limit: 100,
          offset: 0,
        }),
      });
      return;
    }
    if (pathname === "/api/documents/stats") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documentCount: docs.length,
          fragmentCount: docs.length,
          agentId: "ui-smoke-agent",
        }),
      });
      return;
    }
    if (pathname === "/api/documents/search") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          query: url.searchParams.get("q") ?? "",
          threshold: 0.3,
          results: [],
          count: 0,
        }),
      });
      return;
    }
    const fragmentsMatch = pathname.match(
      /^\/api\/documents\/([^/]+)\/fragments$/,
    );
    if (fragmentsMatch) {
      const doc = docs.find((d) => d.id === fragmentsMatch[1]);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documentId: fragmentsMatch[1],
          fragments: doc
            ? [
                {
                  id: `${doc.id}-frag-0`,
                  text: doc.content.text,
                  position: 0,
                  createdAt: doc.createdAt,
                },
              ]
            : [],
          count: doc ? 1 : 0,
        }),
      });
      return;
    }
    const detailMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
    if (detailMatch) {
      const doc = docs.find((d) => d.id === detailMatch[1]);
      if (doc) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ document: doc }),
        });
        return;
      }
    }
    await route.fallback();
  });

  return { bulkCalls: () => [...bulkCalls] };
}

const DROPPED_NOTE_TEXT =
  "# Dropped note\n\nThis exact markdown body must arrive in the bulk upload payload.\n";

// NOTE (#10722 finding): the UploadZone fieldset ("Drop files here to
// upload") is UNMOUNTED in the shipped app — the only live documents surface
// (CharacterHubView → /character/documents) passes showSelectorRail={false},
// and the companion-overlay editor variant that mounts it is itself mounted
// nowhere. The root-level drop intake on DocumentsView (added with this
// harness) is what makes drag-drop knowledge upload reachable again; these
// tests drive that shipped path.
test.describe("knowledge view — real DataTransfer file drop", () => {
  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
  });

  test("dropping a markdown file on the knowledge view ingests it through the upload pipeline", async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    const api = await installStatefulDocumentsApi(page);

    await openAppPath(page, "/character/documents");
    const view = page.getByTestId("documents-view");
    await expect(view).toBeVisible({ timeout: 60_000 });
    await evidenceShot(page, "documents-01-before-drop");

    const dt = await fileDataTransfer(page, [
      {
        name: "dropped-note.md",
        mimeType: "text/markdown",
        base64: Buffer.from(DROPPED_NOTE_TEXT, "utf8").toString("base64"),
      },
    ]);
    await dropFilesOn(view, dt);

    // The renderer read the dropped file and POSTed the EXACT bytes.
    await expect
      .poll(() => api.bulkCalls().length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const posted = api.bulkCalls()[0]?.documents?.[0];
    expect(posted?.filename).toBe("dropped-note.md");
    expect(posted?.contentType).toBe("text/markdown");
    expect(posted?.content).toBe(DROPPED_NOTE_TEXT);
    expect(posted?.scope).toBe("user-private");
    expect(posted?.metadata?.includeImageDescriptions).toBe(true);

    // The ingested document appears in the refreshed list (compact doc strip).
    await expect(view.getByText("dropped-note.md").first()).toBeVisible({
      timeout: 20_000,
    });
    await evidenceShot(page, "documents-02-ingested-in-list");

    // Concurrency edge: a second drop right after the first must ingest too —
    // the pipeline serializes, never drops or duplicates.
    const dt2 = await fileDataTransfer(page, [
      {
        name: "second-note.md",
        mimeType: "text/markdown",
        base64: Buffer.from("second body\n", "utf8").toString("base64"),
      },
    ]);
    await dropFilesOn(view, dt2);
    await expect
      .poll(() => api.bulkCalls().length, { timeout: 20_000 })
      .toBe(2);
    await expect(view.getByText("second-note.md").first()).toBeVisible({
      timeout: 20_000,
    });
    await evidenceShot(page, "documents-03-second-drop-ingested");
    expect(pageErrors).toEqual([]);
  });

  test("a drop with no files is a no-op — no upload request leaves the renderer", async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    const api = await installStatefulDocumentsApi(page);

    await openAppPath(page, "/character/documents");
    const view = page.getByTestId("documents-view");
    await expect(view).toBeVisible({ timeout: 60_000 });

    const textDt = await textDataTransfer(page);
    await dropFilesOn(view, textDt);
    await page.waitForTimeout(800);
    expect(api.bulkCalls()).toHaveLength(0);
    expect(pageErrors).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Surface 4 — production launcher is curated: no reorder DnD by design.
 * LauncherSurface supplies pageGroups, which hard-disables edit mode and the
 * Reorder wrappers. This contract test locks that in with real gestures: a
 * long-press must NOT enter edit mode, and a real tile drag must NOT reorder
 * or write a manual layout.
 * ──────────────────────────────────────────────────────────────────────────── */

async function launcherTileIds(page: Page): Promise<string[]> {
  return page
    .getByTestId("launcher-page-0")
    .locator('[data-testid^="launcher-tile-"]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) =>
          (node.getAttribute("data-testid") ?? "").replace(
            "launcher-tile-",
            "",
          ),
        )
        .filter(Boolean),
    );
}

test.describe("production launcher — curated pages, reorder disabled by design", () => {
  test("long-press does not enter edit mode and a real drag does not reorder", async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await page.route("**/api/avatar/vrm", async (route) => {
      const method = route.request().method();
      if (method !== "HEAD" && method !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({ status: 204 });
    });

    await openAppPath(page, "/views");
    await expect(page.getByTestId("launcher")).toBeVisible({ timeout: 60_000 });
    const firstPage = page.getByTestId("launcher-page-0");
    await expect(
      firstPage.locator('[data-testid^="launcher-tile-"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    const initialIds = await launcherTileIds(page);
    expect(initialIds.length).toBeGreaterThan(1);

    // REAL long-press: press and hold well past the 450ms threshold without
    // moving. In the curated production launcher this must NOT enter edit mode
    // (no jiggle animation, no pin/unpin chips).
    const firstTile = firstPage
      .locator('[data-testid^="launcher-tile-"]')
      .first();
    const tileBox = await firstTile.boundingBox();
    if (!tileBox) throw new Error("launcher tile has no layout box");
    await page.mouse.move(
      tileBox.x + tileBox.width / 2,
      tileBox.y + tileBox.height / 2,
    );
    await page.mouse.down();
    await page.waitForTimeout(700);
    await expect(page.locator(".animate-pulse")).toHaveCount(0);
    await expect(page.locator('[data-testid^="launcher-fav-"]')).toHaveCount(0);
    // Release OFF the tile so the hold cannot register as a launch tap.
    await page.mouse.move(tileBox.x - 40, tileBox.y - 40, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator(".animate-pulse")).toHaveCount(0);
    await evidenceShot(page, "launcher-01-longpress-no-edit-mode");

    // REAL drag of one tile onto a tile in another row: curated pages render
    // no Reorder wrapper, so the grid order must be unchanged.
    const tiles = firstPage.locator('[data-testid^="launcher-tile-"]');
    const dragTargetIndex = Math.min(initialIds.length - 1, 4);
    await realMouseDrag(page, tiles.first(), tiles.nth(dragTargetIndex), {
      pathSegments: 6,
    });
    expect(await launcherTileIds(page)).toEqual(initialIds);

    // No manual layout was persisted by the gesture.
    const layoutRaw = await readLocalStorage(page, "elizaos.views.launcher");
    if (layoutRaw) {
      const layout = JSON.parse(layoutRaw) as { manual?: boolean };
      expect(layout.manual).not.toBe(true);
    }
    await evidenceShot(page, "launcher-02-drag-noop-curated");
    expect(pageErrors).toEqual([]);
  });
});
