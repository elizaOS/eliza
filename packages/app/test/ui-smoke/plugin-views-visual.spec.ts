import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

type ViewCase = {
  id: string;
  viewType: "gui" | "tui";
  path: string;
};

type ViewAudit = {
  id: string;
  viewType: "gui" | "tui";
  path: string;
  captureRunId: string;
  captureState: "pre-overlay" | "post-overlay";
  capturedAt: string;
  viewport: {
    width: number;
    height: number;
  } | null;
  visibleText: string;
  visualSignals: {
    total: number;
    images: number;
    svg: number;
    canvas: number;
    video: number;
    roleImages: number;
    iconButtons: number;
    interactiveControls: number;
    indicators: number;
    terminalCommands: number;
  };
  textToVisualSignalRatio: number;
  assetIntegrity: {
    images: Array<{
      src: string;
      alt: string | null;
      ariaLabel: string | null;
      complete: boolean;
      naturalWidth: number;
      naturalHeight: number;
    }>;
    brokenImages: Array<{
      src: string;
      alt: string | null;
      complete: boolean;
      naturalWidth: number;
      naturalHeight: number;
    }>;
    canvases: Array<{
      width: number;
      height: number;
      clientWidth: number;
      clientHeight: number;
      sampled2dNonBlank: boolean | null;
    }>;
  };
  redundantHeadingParagraphs: Array<{
    heading: string;
    paragraph: string;
    relation: "before" | "after";
  }>;
  controls: Array<{
    tag: string;
    role: string | null;
    type: string | null;
    text: string;
    ariaLabel: string | null;
    disabled: boolean;
    inTuiRoot: boolean;
    terminalCommand: string | null;
  }>;
  focusedAfterTabs: string[];
};

type RawViewAudit = Omit<
  ViewAudit,
  "captureRunId" | "captureState" | "capturedAt" | "viewport"
>;

type TuiRouteContract = {
  visibleText: string[];
  controlLabels?: string[];
  buttonNames?: string[];
  viewState?: Record<string, string | number | boolean | null>;
};

type ViewReview = {
  status: "captured" | "pending";
  likes: string[];
  issues: string[];
  actionItems: string[];
};

const REVIEW_RUN_ID =
  process.env.ELIZA_VIEW_REVIEW_RUN_ID ??
  `plugin-views-${Date.now().toString(36)}-${process.pid}`;
const currentRunPrimaryCaptures = new Set<string>();

const VIEW_CASES: ViewCase[] = [
  ["companion", "gui", "/companion"],
  ["companion", "tui", "/companion/tui"],
  ["contacts", "gui", "/contacts"],
  ["contacts", "tui", "/contacts/tui"],
  ["hyperliquid", "gui", "/hyperliquid"],
  ["hyperliquid", "tui", "/hyperliquid/tui"],
  ["lifeops", "gui", "/lifeops"],
  ["lifeops", "tui", "/lifeops/tui"],
  ["messages", "gui", "/messages"],
  ["messages", "tui", "/messages/tui"],
  ["model-tester", "gui", "/model-tester"],
  ["model-tester", "tui", "/model-tester/tui"],
  ["phone", "gui", "/phone"],
  ["phone", "tui", "/phone/tui"],
  ["polymarket", "gui", "/polymarket"],
  ["polymarket", "tui", "/polymarket/tui"],
  ["shopify", "gui", "/shopify"],
  ["shopify", "tui", "/shopify/tui"],
  ["steward", "gui", "/steward"],
  ["steward", "tui", "/steward/tui"],
  ["vincent", "gui", "/vincent"],
  ["vincent", "tui", "/vincent/tui"],
  ["wallet", "gui", "/wallet"],
  ["wallet", "tui", "/wallet/tui"],
  ["2004scape", "gui", "/2004scape"],
  ["2004scape", "tui", "/2004scape/tui"],
  ["feed", "gui", "/feed"],
  ["feed", "tui", "/feed/tui"],
  ["views-manager", "gui", "/views"],
  ["views-manager", "tui", "/views/tui"],
  ["clawville", "gui", "/clawville"],
  ["clawville", "tui", "/clawville/tui"],
  ["defense-of-the-agents", "gui", "/defense-of-the-agents"],
  ["defense-of-the-agents", "tui", "/defense-of-the-agents/tui"],
  ["hyperscape", "gui", "/hyperscape"],
  ["hyperscape", "tui", "/hyperscape/tui"],
  ["scape", "gui", "/scape"],
  ["scape", "tui", "/scape/tui"],
  ["screenshare", "gui", "/screenshare"],
  ["screenshare", "tui", "/screenshare/tui"],
  ["task-coordinator", "gui", "/task-coordinator"],
  ["task-coordinator", "tui", "/task-coordinator/tui"],
  ["orchestrator", "gui", "/orchestrator"],
  ["orchestrator", "tui", "/orchestrator/tui"],
  ["trajectory-logger", "gui", "/trajectory-logger"],
  ["trajectory-logger", "tui", "/trajectory-logger/tui"],
  ["training", "gui", "/training"],
  ["training", "tui", "/training/tui"],
  ["facewear", "gui", "/apps/hearwear"],
  ["facewear", "tui", "/apps/hearwear/tui"],
  ["smartglasses", "gui", "/apps/smartglasses"],
  ["smartglasses", "tui", "/apps/smartglasses/tui"],
].map(([id, viewType, viewPath]) => ({
  id,
  viewType: viewType as "gui" | "tui",
  path: viewPath,
}));

const TUI_ROUTE_CONTRACTS: Record<string, TuiRouteContract> = {
  "2004scape": {
    visibleText: [
      "2004scape",
      "run none",
      "session none",
      "commands unavailable",
      "suggested prompts",
    ],
    controlLabels: ["2004scape command"],
    buttonNames: ["check status", "continue tutorial", "pause"],
    viewState: {
      appName: "@elizaos/plugin-2004scape",
      activeRunCount: 0,
      runId: null,
    },
  },
  hyperscape: {
    visibleText: [
      "Hyperscape",
      "run none",
      "session none",
      "follow none",
      "commands unavailable",
      "suggested prompts",
    ],
    controlLabels: ["Hyperscape command"],
    buttonNames: ["look around", "follow target", "pause"],
    viewState: {
      appName: "@elizaos/plugin-hyperscape",
      activeRunCount: 0,
      runId: null,
    },
  },
  scape: {
    visibleText: [
      "'scape",
      "run none",
      "agent unknown",
      "position unknown",
      "commands unavailable",
      "suggested prompts",
    ],
    controlLabels: ["'scape command"],
    buttonNames: ["check status", "set goal", "pause"],
    viewState: {
      appName: "@elizaos/plugin-scape",
      activeRunCount: 0,
      runId: null,
    },
  },
  screenshare: {
    visibleText: [
      "sessions",
      "capabilities",
      "commands: state | start | session | stop | input | viewer-url",
    ],
    buttonNames: ["refresh"],
    viewState: {
      viewId: "screenshare",
    },
  },
  "views-manager": {
    visibleText: ["registered tui views"],
    buttonNames: ["refresh"],
  },
  orchestrator: {
    visibleText: [
      "Orchestrator TUI",
      "orchestrator-status",
      "orchestrator-list-tasks",
      "orchestrator-create-task",
    ],
  },
  "task-coordinator": {
    visibleText: [
      "Task Coordinator TUI",
      "list-sessions",
      "list-task-threads",
      "open-thread",
    ],
  },
};

const TUI_COMMAND_OUTPUT_CONTRACTS: Record<string, Record<string, RegExp[]>> = {
  "views-manager": {
    "terminal-list-views": [/"views"\s*:/],
    "terminal-open-view": [/viewId is required/],
  },
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function brokenCanvases(audit: Pick<ViewAudit, "assetIntegrity">) {
  return audit.assetIntegrity.canvases.filter(
    (canvas) =>
      canvas.width <= 0 ||
      canvas.height <= 0 ||
      canvas.clientWidth <= 0 ||
      canvas.clientHeight <= 0 ||
      canvas.sampled2dNonBlank === false,
  );
}

function viewCaptureKey(view: Pick<ViewCase, "id" | "viewType">): string {
  return `${view.id}:${view.viewType}`;
}

function withAuditMetadata(
  audit: RawViewAudit,
  state: ViewAudit["captureState"],
  viewport: ViewAudit["viewport"],
): ViewAudit {
  return {
    ...audit,
    captureRunId: REVIEW_RUN_ID,
    captureState: state,
    capturedAt: new Date().toISOString(),
    viewport,
  };
}

async function readAuditIfPresent(
  screenshotDir: string,
  view: ViewCase,
): Promise<ViewAudit | null> {
  if (!currentRunPrimaryCaptures.has(viewCaptureKey(view))) return null;
  try {
    const raw = await readFile(
      path.join(screenshotDir, `${view.id}-${view.viewType}.audit.json`),
      "utf8",
    );
    const audit = JSON.parse(raw) as ViewAudit;
    if (audit.captureRunId !== REVIEW_RUN_ID) return null;
    if (audit.captureState !== "pre-overlay") return null;
    if (
      audit.id !== view.id ||
      audit.viewType !== view.viewType ||
      audit.path !== view.path
    ) {
      return null;
    }
    return audit;
  } catch {
    return null;
  }
}

function reviewForAudit(audit: ViewAudit | null): ViewReview {
  if (!audit) {
    return {
      status: "pending",
      likes: [],
      issues: ["Screenshot and audit JSON have not been captured yet."],
      actionItems: ["Run the plugin view visual smoke matrix for this view."],
    };
  }

  const mediaSignals =
    audit.visualSignals.images +
    audit.visualSignals.svg +
    audit.visualSignals.canvas +
    audit.visualSignals.video +
    audit.visualSignals.roleImages +
    audit.visualSignals.iconButtons +
    audit.visualSignals.indicators;
  const enabledControls = audit.controls.filter(
    (control) => !control.disabled,
  ).length;
  const likes: string[] = [];
  const issues: string[] = [];
  const actionItems: string[] = [];

  if (audit.assetIntegrity.brokenImages.length === 0) {
    likes.push("Visible image assets load cleanly.");
  }
  if (brokenCanvases(audit).length === 0) {
    likes.push("Visible canvases are sized and nonblank when sampling works.");
  }
  if (audit.redundantHeadingParagraphs.length === 0) {
    likes.push("No short paragraph copy is rendered directly around headings.");
  }
  if (mediaSignals > 0) {
    likes.push(
      `Uses ${mediaSignals} non-text visual/status signals before counting plain controls.`,
    );
  }
  if (audit.viewType === "tui" && audit.visualSignals.terminalCommands > 0) {
    likes.push(
      `Exposes ${audit.visualSignals.terminalCommands} terminal command affordances.`,
    );
  }
  if (enabledControls > 0) {
    likes.push(`Provides ${enabledControls} enabled interactive controls.`);
  }

  if (audit.textToVisualSignalRatio > 260) {
    issues.push(
      `Text-to-visual ratio is high (${audit.textToVisualSignalRatio.toFixed(1)} chars per signal).`,
    );
    actionItems.push(
      "Move repeated explanatory copy into icons, status chips, imagery, or progressive disclosure.",
    );
  }
  if (mediaSignals === 0) {
    issues.push("No non-text media, icon, canvas, or status signal was found.");
    actionItems.push(
      "Add a stable visual/status affordance so the surface is not text-only.",
    );
  }
  if (audit.assetIntegrity.brokenImages.length > 0) {
    issues.push(
      `${audit.assetIntegrity.brokenImages.length} visible image asset(s) failed to load.`,
    );
    actionItems.push("Fix broken visible image sources or remove the element.");
  }
  const brokenCanvasCount = brokenCanvases(audit).length;
  if (brokenCanvasCount > 0) {
    issues.push(
      `${brokenCanvasCount} visible canvas element(s) were blank or zero-sized.`,
    );
    actionItems.push(
      "Render a stable placeholder or ensure the canvas paints before capture.",
    );
  }
  if (audit.redundantHeadingParagraphs.length > 0) {
    issues.push(
      `${audit.redundantHeadingParagraphs.length} heading-adjacent short paragraph(s) look redundant.`,
    );
    actionItems.push(
      "Remove nearby explanatory paragraphs or convert the information into compact labels.",
    );
  }
  if (audit.viewType === "tui" && audit.controls.length === 0) {
    issues.push("TUI view has no visible controls.");
    actionItems.push("Expose terminal commands or a focused input control.");
  }

  if (likes.length === 0) {
    likes.push("View renders readable content and passed the base smoke gate.");
  }
  if (issues.length === 0) {
    issues.push("No automated visual-review issues were detected.");
  }
  if (actionItems.length === 0) {
    actionItems.push("Manual reviewer should inspect screenshot composition.");
  }

  return {
    status: "captured",
    likes,
    issues,
    actionItems: [...new Set(actionItems)],
  };
}

function markdownList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

async function writeReviewArtifacts(screenshotDir: string): Promise<void> {
  const rows = await Promise.all(
    VIEW_CASES.map(async (view) => ({
      ...view,
      screenshot: `${view.id}-${view.viewType}.png`,
      auditFile: `${view.id}-${view.viewType}.audit.json`,
      postOverlayAuditFile: `${view.id}-${view.viewType}.post-overlay.audit.json`,
      audit: await readAuditIfPresent(screenshotDir, view),
    })),
  );
  const reviewedRows = rows.map((row) => ({
    ...row,
    review: reviewForAudit(row.audit),
  }));
  const completed = rows.filter((row) => row.audit);
  const issueCount = reviewedRows.reduce(
    (count, row) =>
      count +
      row.review.issues.filter(
        (issue) => issue !== "No automated visual-review issues were detected.",
      ).length,
    0,
  );
  const manifest = {
    generatedAt: new Date().toISOString(),
    runId: REVIEW_RUN_ID,
    expectedCount: VIEW_CASES.length,
    completedCount: completed.length,
    complete: completed.length === VIEW_CASES.length,
    issueCount,
    rows: reviewedRows.map((row) => ({
      id: row.id,
      viewType: row.viewType,
      path: row.path,
      screenshot: row.screenshot,
      auditFile: row.auditFile,
      postOverlayAuditFile: row.postOverlayAuditFile,
      status: row.audit ? "captured" : "pending",
      visualSignals: row.audit?.visualSignals ?? null,
      textToVisualSignalRatio: row.audit?.textToVisualSignalRatio ?? null,
      captureRunId: row.audit?.captureRunId ?? null,
      captureState: row.audit?.captureState ?? null,
      capturedAt: row.audit?.capturedAt ?? null,
      viewport: row.audit?.viewport ?? null,
      primaryAggregationSource: row.audit ? "pre-overlay" : null,
      brokenImageCount: row.audit?.assetIntegrity.brokenImages.length ?? null,
      redundantHeadingParagraphCount:
        row.audit?.redundantHeadingParagraphs.length ?? null,
      controlCount: row.audit?.controls.length ?? null,
      review: row.review,
    })),
  };

  await writeFile(
    path.join(screenshotDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const reviewJson = {
    generatedAt: manifest.generatedAt,
    runId: manifest.runId,
    expectedCount: manifest.expectedCount,
    completedCount: manifest.completedCount,
    complete: manifest.complete,
    issueCount: manifest.issueCount,
    rows: reviewedRows.map((row) => ({
      id: row.id,
      viewType: row.viewType,
      path: row.path,
      screenshot: row.screenshot,
      auditFile: row.auditFile,
      postOverlayAuditFile: row.postOverlayAuditFile,
      metrics: row.audit
        ? {
            visualSignals: row.audit.visualSignals,
            textToVisualSignalRatio: row.audit.textToVisualSignalRatio,
            controlCount: row.audit.controls.length,
            brokenImageCount: row.audit.assetIntegrity.brokenImages.length,
            redundantHeadingParagraphCount:
              row.audit.redundantHeadingParagraphs.length,
            captureRunId: row.audit.captureRunId,
            captureState: row.audit.captureState,
            capturedAt: row.audit.capturedAt,
            viewport: row.audit.viewport,
            primaryAggregationSource: "pre-overlay",
          }
        : null,
      review: row.review,
    })),
  };
  await writeFile(
    path.join(screenshotDir, "review.json"),
    `${JSON.stringify(reviewJson, null, 2)}\n`,
  );

  const reviewMarkdown = [
    "# Plugin View Visual Review",
    "",
    `Generated: ${manifest.generatedAt}`,
    `Run ID: ${manifest.runId}`,
    `Captured: ${manifest.completedCount}/${manifest.expectedCount}`,
    `Complete: ${manifest.complete ? "yes" : "no"}`,
    `Automated issue count: ${manifest.issueCount}`,
    "",
    ...reviewedRows.flatMap((row) => {
      const ratio =
        row.audit?.textToVisualSignalRatio === undefined
          ? "pending"
          : row.audit.textToVisualSignalRatio.toFixed(1);
      return [
        `## ${row.id} ${row.viewType}`,
        "",
        `Path: ${row.path}`,
        `Screenshot: ${row.screenshot}`,
        `Audit: ${row.auditFile}`,
        `Post-overlay audit: ${row.postOverlayAuditFile}`,
        `Status: ${row.review.status}`,
        `Capture state: ${row.audit?.captureState ?? "pending"}`,
        `Viewport: ${
          row.audit?.viewport
            ? `${row.audit.viewport.width}x${row.audit.viewport.height}`
            : "pending"
        }`,
        `Text/visual ratio: ${ratio}`,
        "",
        "Likes",
        markdownList(row.review.likes),
        "",
        "Issues",
        markdownList(row.review.issues),
        "",
        "Action Items",
        markdownList(row.review.actionItems),
        "",
      ];
    }),
  ].join("\n");
  await writeFile(path.join(screenshotDir, "review.md"), reviewMarkdown);

  const cards = reviewedRows
    .map((row) => {
      const audit = row.audit;
      const statusClass = audit ? "captured" : "pending";
      const ratio =
        audit?.textToVisualSignalRatio === undefined
          ? "pending"
          : audit.textToVisualSignalRatio.toFixed(1);
      return `
        <article class="card ${statusClass}">
          <a href="./${escapeHtml(row.screenshot)}">
            <img src="./${escapeHtml(row.screenshot)}" alt="${escapeHtml(`${row.id} ${row.viewType}`)}" loading="lazy" />
          </a>
          <div class="meta">
            <h2>${escapeHtml(row.id)} <span>${escapeHtml(row.viewType)}</span></h2>
            <code>${escapeHtml(row.path)}</code>
            <dl>
              <div><dt>visuals</dt><dd>${audit?.visualSignals.total ?? "pending"}</dd></div>
              <div><dt>text/visual</dt><dd>${escapeHtml(ratio)}</dd></div>
              <div><dt>controls</dt><dd>${audit?.controls.length ?? "pending"}</dd></div>
              <div><dt>broken images</dt><dd>${audit?.assetIntegrity.brokenImages.length ?? "pending"}</dd></div>
            </dl>
            <p>${escapeHtml(row.review.issues[0] ?? "No review issue recorded.")}</p>
            <a class="audit" href="./${escapeHtml(row.auditFile)}">audit json</a>
          </div>
        </article>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Plugin View Visual Review</title>
    <style>
      :root { color-scheme: dark; --bg: #090b0f; --panel: #111820; --panel-2: #151f2a; --border: rgba(255,255,255,.1); --text: #f3f6fb; --muted: #9ca8b8; --accent: #f0b232; --bad: #fb7185; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #090b0f; color: var(--text); }
      main { width: min(1800px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 56px; }
      header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
      h1, h2, p { margin: 0; }
      h1 { font-size: 24px; }
      .summary { color: var(--muted); font-size: 13px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
      .card { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); overflow: hidden; }
      .card.pending { border-color: rgba(251,113,133,.45); }
      img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; background: #05070a; border-bottom: 1px solid var(--border); }
      .meta { display: grid; gap: 10px; padding: 12px; }
      h2 { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 14px; }
      h2 span { color: var(--accent); font-size: 11px; text-transform: uppercase; }
      code { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0; }
      dl div { border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); padding: 8px; }
      dt { color: var(--muted); font-size: 10px; text-transform: uppercase; }
      dd { margin: 2px 0 0; font-weight: 700; font-size: 13px; }
      p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
      .audit { color: var(--accent); font-size: 12px; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Plugin View Visual Review</h1>
          <div class="summary">${completed.length}/${VIEW_CASES.length} views captured · generated ${escapeHtml(manifest.generatedAt)}</div>
        </div>
        <nav>
          <a class="audit" href="./manifest.json">manifest.json</a>
          <a class="audit" href="./review.md">review.md</a>
          <a class="audit" href="./review.json">review.json</a>
        </nav>
      </header>
      <section class="grid">${cards}</section>
    </main>
  </body>
</html>`;

  await writeFile(path.join(screenshotDir, "index.html"), html);
}

test.describe("registered plugin views visual coverage", () => {
  for (const view of VIEW_CASES) {
    test(`${view.id} ${view.viewType} renders with assistant pill`, async ({
      page,
    }) => {
      const screenshotDir =
        process.env.ELIZA_VIEW_SCREENSHOT_DIR ??
        path.join(process.cwd(), "test-results", "plugin-views");
      await mkdir(screenshotDir, { recursive: true });

      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") {
          pageErrors.push(message.text());
        }
      });

      await seedAppStorage(page);
      await installDefaultAppRoutes(page);
      await openAppPath(page, view.path);

      await expect(page.getByText("Failed to load view")).toHaveCount(0);

      const viewRoot = page.locator("main").first();
      await expect(viewRoot).toBeVisible();
      await expect
        .poll(
          async () => {
            const text = await viewRoot.evaluate((root) =>
              root.innerText.trim().replace(/\s+/g, " "),
            );
            return text.length > 20 && !/^Loading view\b/.test(text);
          },
          {
            message: `${view.id} ${view.viewType} should finish dynamic view loading before audit`,
            timeout: 30_000,
          },
        )
        .toBe(true);
      await expect(page.getByText(/Loading view/)).toHaveCount(0);
      await expect(page.getByText("Failed to load view")).toHaveCount(0);
      const preOverlayAudit = await viewRoot.evaluate(
        (root, { id, viewType, viewPath }) => {
          const normalize = (value: string | null | undefined) =>
            (value ?? "").trim().replace(/\s+/g, " ");
          const visibleElements = (selector: string) =>
            Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
              (element) => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
              },
            );
          const controls = Array.from(
            root.querySelectorAll<HTMLElement>(
              "button, input, textarea, select, [role='button'], [role='menuitem'], [role='tab']",
            ),
          )
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            })
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              type: element.getAttribute("type"),
              text: normalize(element.textContent).slice(0, 120),
              ariaLabel: element.getAttribute("aria-label"),
              disabled:
                element.hasAttribute("disabled") ||
                element.getAttribute("aria-disabled") === "true",
              inTuiRoot: Boolean(element.closest("[data-view-state]")),
              terminalCommand: element.getAttribute("data-terminal-command"),
            }));
          const terminalCommands = visibleElements(
            "[data-terminal-command]",
          ).length;
          const visualSignals = {
            total: 0,
            images: visibleElements("img, picture").length,
            svg: visibleElements("svg").length,
            canvas: visibleElements("canvas").length,
            video: visibleElements("video").length,
            roleImages: visibleElements("[role='img']").length,
            iconButtons: controls.filter(
              (control) =>
                !control.text &&
                Boolean(control.ariaLabel) &&
                control.tag === "button",
            ).length,
            interactiveControls: controls.filter((control) => !control.disabled)
              .length,
            indicators: visibleElements(
              "[data-status], [data-state], [aria-current], .rounded-full, [class*='rounded-full']",
            ).length,
            terminalCommands,
          };
          visualSignals.total =
            visualSignals.images +
            visualSignals.svg +
            visualSignals.canvas +
            visualSignals.video +
            visualSignals.roleImages +
            visualSignals.iconButtons +
            visualSignals.interactiveControls +
            visualSignals.indicators +
            visualSignals.terminalCommands;
          const redundantHeadingParagraphs = Array.from(
            root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
          ).flatMap((heading) => {
            const headingText = normalize(heading.textContent).slice(0, 120);
            const candidates = [
              ["after", heading.nextElementSibling],
              ["before", heading.previousElementSibling],
            ] as const;
            return candidates.flatMap(([relation, sibling]) => {
              if (!(sibling instanceof HTMLElement)) return [];
              if (sibling.tagName.toLowerCase() !== "p") return [];
              const paragraph = normalize(sibling.textContent);
              const hasInteractiveOrVisual = Boolean(
                sibling.querySelector(
                  "button, input, textarea, select, img, picture, svg, canvas, video",
                ),
              );
              if (
                !paragraph ||
                paragraph.length > 180 ||
                hasInteractiveOrVisual
              ) {
                return [];
              }
              return [
                {
                  heading: headingText,
                  paragraph: paragraph.slice(0, 180),
                  relation,
                },
              ];
            });
          });
          const images = visibleElements("img").map((element) => {
            const image = element as HTMLImageElement;
            return {
              src: image.currentSrc || image.src,
              alt: image.getAttribute("alt"),
              ariaLabel: image.getAttribute("aria-label"),
              complete: image.complete,
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
            };
          });
          const canvases = visibleElements("canvas").map((element) => {
            const canvas = element as HTMLCanvasElement;
            let sampled2dNonBlank: boolean | null = null;
            try {
              const context = canvas.getContext("2d", {
                willReadFrequently: true,
              });
              if (context && canvas.width > 0 && canvas.height > 0) {
                const sample = context.getImageData(
                  0,
                  0,
                  Math.min(canvas.width, 16),
                  Math.min(canvas.height, 16),
                ).data;
                sampled2dNonBlank = Array.from(sample).some(
                  (value) => value !== 0,
                );
              }
            } catch {
              sampled2dNonBlank = null;
            }
            return {
              width: canvas.width,
              height: canvas.height,
              clientWidth: canvas.clientWidth,
              clientHeight: canvas.clientHeight,
              sampled2dNonBlank,
            };
          });
          const assetIntegrity = {
            images,
            brokenImages: images
              .filter((image) => !image.complete || image.naturalWidth <= 0)
              .map((image) => ({
                src: image.src,
                alt: image.alt,
                complete: image.complete,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
              })),
            canvases,
          };
          const visibleText = normalize(root.innerText).slice(0, 4000);
          return {
            id,
            viewType,
            path: viewPath,
            visibleText,
            visualSignals,
            textToVisualSignalRatio:
              visibleText.length / Math.max(1, visualSignals.total),
            assetIntegrity,
            redundantHeadingParagraphs,
            controls,
            focusedAfterTabs: [],
          } satisfies RawViewAudit;
        },
        {
          id: view.id,
          viewType: view.viewType,
          viewPath: view.path,
        },
      );

      expect(
        preOverlayAudit.visibleText.length,
        `${view.id} ${view.viewType} should expose readable view text before opening the assistant overlay`,
      ).toBeGreaterThan(20);
      expect(
        preOverlayAudit.visualSignals.total,
        `${view.id} ${view.viewType} should expose visual/icon/indicator signals before opening the assistant overlay`,
      ).toBeGreaterThan(0);
      expect(
        preOverlayAudit.redundantHeadingParagraphs,
        `${view.id} ${view.viewType} should not render short paragraph copy directly above/below headings`,
      ).toEqual([]);
      expect(
        preOverlayAudit.assetIntegrity.brokenImages,
        `${view.id} ${view.viewType} should not render broken visible images before opening the assistant overlay`,
      ).toEqual([]);
      expect(
        brokenCanvases(preOverlayAudit),
        `${view.id} ${view.viewType} should not render blank or zero-sized visible canvases before opening the assistant overlay`,
      ).toEqual([]);
      if (view.id !== "views-manager") {
        expect(
          preOverlayAudit.visibleText,
          `${view.id} ${view.viewType} should not fall through to the View Manager`,
        ).not.toMatch(/^View Manager \d+ views\b/);
      }

      const preOverlayReviewAudit = withAuditMetadata(
        preOverlayAudit,
        "pre-overlay",
        page.viewportSize(),
      );
      await writeFile(
        path.join(screenshotDir, `${view.id}-${view.viewType}.audit.json`),
        `${JSON.stringify(preOverlayReviewAudit, null, 2)}\n`,
      );
      await captureScreenshotWithQualityRetry(
        page,
        `${view.id} ${view.viewType}`,
        {
          fullPage: false,
          path: path.join(screenshotDir, `${view.id}-${view.viewType}.png`),
          attempts: 4,
        },
      );
      currentRunPrimaryCaptures.add(viewCaptureKey(view));

      if (view.viewType === "tui") {
        const tuiRoot = viewRoot.locator("[data-view-state]").first();
        await expect(
          tuiRoot,
          `${view.id} ${view.viewType} should render a terminal view root`,
        ).toBeVisible();
        await expect(
          viewRoot.getByText(`elizaos://${view.id} --type=tui`).first(),
          `${view.id} ${view.viewType} should render its own terminal header`,
        ).toBeVisible();
        const viewState = await tuiRoot.evaluate((element) =>
          JSON.parse(element.getAttribute("data-view-state") ?? "{}"),
        );
        expect(
          viewState,
          `${view.id} ${view.viewType} should expose a machine-readable TUI state contract`,
        ).toMatchObject({
          viewType: "tui",
          ...(TUI_ROUTE_CONTRACTS[view.id]?.viewState ?? {}),
        });
        if ("viewId" in viewState) {
          expect(
            viewState.viewId,
            `${view.id} ${view.viewType} should not expose another view id in its TUI state`,
          ).toBe(view.id);
        }

        const routeContract = TUI_ROUTE_CONTRACTS[view.id];
        for (const text of routeContract?.visibleText ?? []) {
          await expect(
            tuiRoot.getByText(text, { exact: false }).first(),
            `${view.id} ${view.viewType} should render route-specific TUI text "${text}"`,
          ).toBeVisible();
        }
        for (const label of routeContract?.controlLabels ?? []) {
          await expect(
            tuiRoot.getByLabel(label).first(),
            `${view.id} ${view.viewType} should expose TUI control "${label}"`,
          ).toBeVisible();
        }
        for (const name of routeContract?.buttonNames ?? []) {
          await expect(
            tuiRoot.getByRole("button", { name }).first(),
            `${view.id} ${view.viewType} should expose TUI button "${name}"`,
          ).toBeVisible();
        }

        const terminalCommands = await tuiRoot
          .locator("[data-terminal-command]")
          .evaluateAll((elements) =>
            elements.map((element) =>
              element.getAttribute("data-terminal-command"),
            ),
          );
        const terminalCommandCount = terminalCommands.length;
        if (terminalCommandCount > 0) {
          for (let index = 0; index < terminalCommandCount; index += 1) {
            await tuiRoot.locator("[data-terminal-command]").nth(index).click();
          }
          await expect(
            tuiRoot.locator("[data-terminal-output]"),
            `${view.id} ${view.viewType} should render output for every terminal command`,
          ).toHaveCount(terminalCommandCount);
          for (let index = 0; index < terminalCommands.length; index += 1) {
            const command = terminalCommands[index];
            if (!command) continue;
            await expect(
              tuiRoot.locator("[data-terminal-output]").nth(index),
              `${view.id} ${view.viewType} command "${command}" should settle with command-specific output`,
            ).toContainText(new RegExp(`\\$\\s+${escapeRegExp(command)}`));
            await expect(
              tuiRoot.locator("[data-terminal-output]").nth(index),
              `${view.id} ${view.viewType} command "${command}" should not remain pending`,
            ).toContainText(/\[(ok|error)\]/);
            for (const expectedOutput of TUI_COMMAND_OUTPUT_CONTRACTS[
              view.id
            ]?.[command] ?? []) {
              await expect(
                tuiRoot.locator("[data-terminal-output]").nth(index),
                `${view.id} ${view.viewType} command "${command}" should expose semantic output matching ${expectedOutput}`,
              ).toContainText(expectedOutput);
            }
          }
        }
      }

      const assistantPill = page.getByTestId("shell-home-pill");
      await expect(assistantPill).toBeVisible();
      await expect(assistantPill).toHaveAttribute("aria-label", "Open Eliza");
      await assistantPill.click();
      await expect(page.getByTestId("shell-assistant-overlay")).toBeVisible();
      await expect(page.getByLabel("Message Eliza")).toBeVisible();

      const focusedAfterTabs: string[] = [];
      focusedAfterTabs.push(
        await page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          if (!element) return "";
          return [
            element.tagName.toLowerCase(),
            element.getAttribute("role") ?? "",
            element.getAttribute("aria-label") ?? "",
            element.getAttribute("data-testid") ?? "",
            element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ?? "",
          ]
            .filter(Boolean)
            .join(":");
        }),
      );
      for (let index = 0; index < 12; index += 1) {
        await page.keyboard.press("Tab");
        focusedAfterTabs.push(
          await page.evaluate(() => {
            const element = document.activeElement as HTMLElement | null;
            if (!element) return "";
            return [
              element.tagName.toLowerCase(),
              element.getAttribute("role") ?? "",
              element.getAttribute("aria-label") ?? "",
              element.getAttribute("data-testid") ?? "",
              element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ??
                "",
            ]
              .filter(Boolean)
              .join(":");
          }),
        );
      }

      const audit = await page.evaluate(
        ({ id, viewType, viewPath, focused }) => {
          const root = document.querySelector("main") ?? document.body;
          const normalize = (value: string | null | undefined) =>
            (value ?? "").trim().replace(/\s+/g, " ");
          const visibleElements = (selector: string) =>
            Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
              (element) => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
              },
            );
          const controls = Array.from(
            root.querySelectorAll<HTMLElement>(
              "button, input, textarea, select, [role='button'], [role='menuitem'], [role='tab']",
            ),
          )
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            })
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              type: element.getAttribute("type"),
              text: normalize(element.textContent).slice(0, 120),
              ariaLabel: element.getAttribute("aria-label"),
              disabled:
                element.hasAttribute("disabled") ||
                element.getAttribute("aria-disabled") === "true",
              inTuiRoot: Boolean(element.closest("[data-view-state]")),
              terminalCommand: element.getAttribute("data-terminal-command"),
            }));
          const terminalCommands = visibleElements(
            "[data-terminal-command]",
          ).length;
          const visualSignals = {
            total: 0,
            images: visibleElements("img, picture").length,
            svg: visibleElements("svg").length,
            canvas: visibleElements("canvas").length,
            video: visibleElements("video").length,
            roleImages: visibleElements("[role='img']").length,
            iconButtons: controls.filter(
              (control) =>
                !control.text &&
                Boolean(control.ariaLabel) &&
                control.tag === "button",
            ).length,
            interactiveControls: controls.filter((control) => !control.disabled)
              .length,
            indicators: visibleElements(
              "[data-status], [data-state], [aria-current], .rounded-full, [class*='rounded-full']",
            ).length,
            terminalCommands,
          };
          visualSignals.total =
            visualSignals.images +
            visualSignals.svg +
            visualSignals.canvas +
            visualSignals.video +
            visualSignals.roleImages +
            visualSignals.iconButtons +
            visualSignals.interactiveControls +
            visualSignals.indicators +
            visualSignals.terminalCommands;
          const redundantHeadingParagraphs = Array.from(
            root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
          ).flatMap((heading) => {
            const headingText = normalize(heading.textContent).slice(0, 120);
            const candidates = [
              ["after", heading.nextElementSibling],
              ["before", heading.previousElementSibling],
            ] as const;
            return candidates.flatMap(([relation, sibling]) => {
              if (!(sibling instanceof HTMLElement)) return [];
              if (sibling.tagName.toLowerCase() !== "p") return [];
              const paragraph = normalize(sibling.textContent);
              const hasInteractiveOrVisual = Boolean(
                sibling.querySelector(
                  "button, input, textarea, select, img, picture, svg, canvas, video",
                ),
              );
              if (
                !paragraph ||
                paragraph.length > 180 ||
                hasInteractiveOrVisual
              ) {
                return [];
              }
              return [
                {
                  heading: headingText,
                  paragraph: paragraph.slice(0, 180),
                  relation,
                },
              ];
            });
          });
          const images = visibleElements("img").map((element) => {
            const image = element as HTMLImageElement;
            return {
              src: image.currentSrc || image.src,
              alt: image.getAttribute("alt"),
              ariaLabel: image.getAttribute("aria-label"),
              complete: image.complete,
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
            };
          });
          const canvases = visibleElements("canvas").map((element) => {
            const canvas = element as HTMLCanvasElement;
            let sampled2dNonBlank: boolean | null = null;
            try {
              const context = canvas.getContext("2d", {
                willReadFrequently: true,
              });
              if (context && canvas.width > 0 && canvas.height > 0) {
                const sample = context.getImageData(
                  0,
                  0,
                  Math.min(canvas.width, 16),
                  Math.min(canvas.height, 16),
                ).data;
                sampled2dNonBlank = Array.from(sample).some(
                  (value) => value !== 0,
                );
              }
            } catch {
              sampled2dNonBlank = null;
            }
            return {
              width: canvas.width,
              height: canvas.height,
              clientWidth: canvas.clientWidth,
              clientHeight: canvas.clientHeight,
              sampled2dNonBlank,
            };
          });
          const assetIntegrity = {
            images,
            brokenImages: images
              .filter((image) => !image.complete || image.naturalWidth <= 0)
              .map((image) => ({
                src: image.src,
                alt: image.alt,
                complete: image.complete,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
              })),
            canvases,
          };
          const visibleText = normalize(root.textContent).slice(0, 4000);
          return {
            id,
            viewType,
            path: viewPath,
            visibleText,
            visualSignals,
            textToVisualSignalRatio:
              visibleText.length / Math.max(1, visualSignals.total),
            assetIntegrity,
            redundantHeadingParagraphs,
            controls,
            focusedAfterTabs: focused,
          } satisfies RawViewAudit;
        },
        {
          id: view.id,
          viewType: view.viewType,
          viewPath: view.path,
          focused: focusedAfterTabs,
        },
      );

      expect(
        audit.visibleText.length,
        `${view.id} ${view.viewType} should expose readable text`,
      ).toBeGreaterThan(20);
      expect(
        audit.visualSignals.total,
        `${view.id} ${view.viewType} should keep visual/icon/indicator signals available after opening the assistant overlay`,
      ).toBeGreaterThan(0);
      expect(
        audit.assetIntegrity.brokenImages,
        `${view.id} ${view.viewType} should not render broken visible images after opening the assistant overlay`,
      ).toEqual([]);
      expect(
        brokenCanvases(audit),
        `${view.id} ${view.viewType} should not render blank or zero-sized visible canvases after opening the assistant overlay`,
      ).toEqual([]);
      if (view.viewType === "tui") {
        expect(
          audit.controls.length,
          `${view.id} ${view.viewType} should expose terminal controls inside the view, not only assistant overlay controls`,
        ).toBeGreaterThan(0);
      }
      expect(
        focusedAfterTabs.some(
          (entry) =>
            entry.includes("textarea") ||
            entry.includes("input") ||
            entry.includes("Message Eliza"),
        ),
        `${view.id} ${view.viewType} keyboard tab order should reach assistant composer`,
      ).toBe(true);
      if (view.viewType === "tui") {
        expect(
          focusedAfterTabs.some(
            (entry) =>
              entry.includes("button") ||
              entry.includes("input") ||
              entry.includes("textarea"),
          ),
          `${view.id} ${view.viewType} keyboard tab order should reach an actionable control`,
        ).toBe(true);
      }

      await writeFile(
        path.join(
          screenshotDir,
          `${view.id}-${view.viewType}.post-overlay.audit.json`,
        ),
        `${JSON.stringify(
          withAuditMetadata(audit, "post-overlay", page.viewportSize()),
          null,
          2,
        )}\n`,
      );
      await writeReviewArtifacts(screenshotDir);

      expect(
        pageErrors,
        `${view.id} ${view.viewType} console/page errors`,
      ).toEqual([]);
    });
  }
});
