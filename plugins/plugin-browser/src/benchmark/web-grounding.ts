/**
 * Web-element grounding harness (#10333, follow-up to #9476).
 *
 * The second "Needs CI infra" item: a ScreenSpot-Web-style point-in-bbox
 * grounding benchmark wired through the **real browser screenshot + click path**
 * (mirrors `plugin-computeruse/src/parity/screenspot.ts`, which scores desktop
 * grounding the same way). Where the MiniWoB++ lane scores *action sequences*,
 * this scores *grounding*: given an instruction + a rendered page, a grounder
 * predicts a click point and the sample is correct iff the point lands inside
 * the target element's on-screen bounding box.
 *
 * The samples are produced by rendering self-contained pages in a real Chromium
 * (the same {@link ChromiumBenchmarkEngine} the MiniWoB++ real lane uses) and
 * reading each target's true screen bbox via the browser — never a hand-written
 * bbox. As in the computeruse harness the large/licensed real dataset is not
 * vendored; a grounder + these synthetic-but-real-rendered samples exercise the
 * scorer.
 */

import type { ChromiumBenchmarkEngine } from "./chromium-executor.js";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A predicted point lands inside the box (inclusive of edges). Pure. */
export function pointInBox(point: Point, box: Box): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

/** A self-contained grounding task: an instruction + the element it refers to. */
export interface WebGroundingTask {
  id: string;
  /** Natural-language target, e.g. `Click the "Submit" button`. */
  instruction: string;
  /** CSS selector of the ground-truth target element. */
  targetSelector: string;
  /** Optional breakdown group (e.g. `"button"` / `"link"` / `"icon"`). */
  group?: string;
  startUrl: string;
  routes: ReadonlyArray<{ url: string; html: string }>;
}

/** A task rendered in a real browser: the target's true on-screen bbox + size. */
export interface GroundingSample {
  task: WebGroundingTask;
  box: Box;
  imageWidth: number;
  imageHeight: number;
}

/** A grounder maps a rendered sample → a predicted click point (or null = abstain). */
export type Grounder = (
  sample: GroundingSample,
) => Promise<Point | null> | Point | null;

/** The oracle: click the centre of the target box. Always correct. */
export const centerGrounder: Grounder = (sample) => ({
  x: sample.box.x + sample.box.width / 2,
  y: sample.box.y + sample.box.height / 2,
});

/**
 * An adversarial grounder that always predicts the top-left viewport corner —
 * outside any centred target — so the scorer must report 0 unless the target
 * genuinely covers the corner. Proves point-in-bbox isn't hard-coded to pass.
 */
export const cornerGrounder: Grounder = () => ({ x: 0, y: 0 });

export interface GroundingSampleResult {
  id: string;
  group?: string;
  instruction: string;
  box: Box;
  predicted: Point | null;
  correct: boolean;
}

export interface GroundingScore {
  total: number;
  correct: number;
  accuracy: number;
  byGroup: Record<string, { total: number; correct: number; accuracy: number }>;
  results: GroundingSampleResult[];
}

/**
 * Render every task in a real Chromium, read each target's true screen bbox,
 * run the grounder, and fold point-in-bbox accuracy (+ per-group breakdown).
 * `onSample` is an optional hook (e.g. screenshot capture for evidence) invoked
 * with the live page while the sample is still mounted.
 */
export async function scoreWebGrounding(
  engine: ChromiumBenchmarkEngine,
  tasks: readonly WebGroundingTask[],
  grounder: Grounder,
  onSample?: (args: {
    task: WebGroundingTask;
    box: Box;
    predicted: Point | null;
    correct: boolean;
  }) => Promise<void>,
): Promise<GroundingScore> {
  const results: GroundingSampleResult[] = [];
  const groups = new Map<string, { total: number; correct: number }>();

  for (const task of tasks) {
    const { executor, dispose } = await engine.makeExecutor();
    const page = engine.currentPage();
    try {
      for (const route of task.routes) {
        await executor.execute({
          subaction: "network",
          networkAction: "route",
          url: route.url,
          responseBody: route.html,
        });
      }
      await executor.execute({ subaction: "navigate", url: task.startUrl });

      const handle = page ? await page.$(task.targetSelector) : null;
      const rawBox = handle ? await handle.boundingBox() : null;
      if (!page || !rawBox) {
        results.push({
          id: task.id,
          ...(task.group ? { group: task.group } : {}),
          instruction: task.instruction,
          box: { x: 0, y: 0, width: 0, height: 0 },
          predicted: null,
          correct: false,
        });
        const key = task.group ?? "all";
        const g = groups.get(key) ?? { total: 0, correct: 0 };
        g.total += 1;
        groups.set(key, g);
        continue;
      }
      const box: Box = {
        x: rawBox.x,
        y: rawBox.y,
        width: rawBox.width,
        height: rawBox.height,
      };
      const viewport = page.viewport();
      const sample: GroundingSample = {
        task,
        box,
        imageWidth: viewport?.width ?? Math.round(box.x + box.width),
        imageHeight: viewport?.height ?? Math.round(box.y + box.height),
      };
      const predicted = await grounder(sample);
      const correct = predicted ? pointInBox(predicted, box) : false;
      results.push({
        id: task.id,
        ...(task.group ? { group: task.group } : {}),
        instruction: task.instruction,
        box,
        predicted,
        correct,
      });
      const key = task.group ?? "all";
      const g = groups.get(key) ?? { total: 0, correct: 0 };
      g.total += 1;
      if (correct) g.correct += 1;
      groups.set(key, g);
      if (onSample) await onSample({ task, box, predicted, correct });
    } finally {
      await dispose();
    }
  }

  const correct = results.filter((r) => r.correct).length;
  const total = results.length;
  const byGroup: GroundingScore["byGroup"] = {};
  for (const [key, g] of groups) {
    byGroup[key] = {
      total: g.total,
      correct: g.correct,
      accuracy: g.total > 0 ? g.correct / g.total : 0,
    };
  }
  return {
    total,
    correct,
    accuracy: total > 0 ? correct / total : 0,
    byGroup,
    results,
  };
}

const GROUNDING_ORIGIN = "https://grounding.test";

function page(title: string, instruction: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#0d0d14;color:#e8e6f0}
  #wob-query{font-size:15px;margin-bottom:18px;color:#cbbdf0}
  .row{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0}
  button,a.btn{display:inline-block;padding:10px 18px;border-radius:8px;border:1px solid #3a2f55;
    background:#1c1730;color:#e8e6f0;text-decoration:none;font-size:14px;cursor:pointer}
  .target{background:#ff5800;border-color:#ff5800;color:#0d0d14;font-weight:600}
</style></head>
<body><div id="wob-query">${instruction}</div><main>${body}</main></body></html>`;
}

/**
 * A small, faithful ScreenSpot-Web-style set: each renders a target element
 * (highlighted) among same-shaped distractors, so grounding to the right element
 * is non-trivial. Targets span buttons, links, and an icon control.
 */
export const WEB_GROUNDING_TASKS: readonly WebGroundingTask[] = [
  {
    id: "ground-button",
    instruction: 'Click the "Submit" button.',
    targetSelector: "#submit",
    group: "button",
    startUrl: `${GROUNDING_ORIGIN}/buttons`,
    routes: [
      {
        url: `${GROUNDING_ORIGIN}/buttons`,
        html: page(
          "Buttons",
          'Click the "Submit" button.',
          `<div class="row">
            <button id="cancel">Cancel</button>
            <button id="back">Back</button>
            <button id="submit" class="target">Submit</button>
            <button id="next">Next</button>
          </div>`,
        ),
      },
    ],
  },
  {
    id: "ground-link",
    instruction: 'Click the "Pricing" link.',
    targetSelector: "#pricing",
    group: "link",
    startUrl: `${GROUNDING_ORIGIN}/nav`,
    routes: [
      {
        url: `${GROUNDING_ORIGIN}/nav`,
        html: page(
          "Nav",
          'Click the "Pricing" link.',
          `<div class="row">
            <a id="home" class="btn" href="#">Home</a>
            <a id="docs" class="btn" href="#">Docs</a>
            <a id="pricing" class="btn target" href="#">Pricing</a>
            <a id="contact" class="btn" href="#">Contact</a>
          </div>`,
        ),
      },
    ],
  },
  {
    id: "ground-icon",
    instruction: "Click the settings (gear) icon.",
    targetSelector: "#settings",
    group: "icon",
    startUrl: `${GROUNDING_ORIGIN}/toolbar`,
    routes: [
      {
        url: `${GROUNDING_ORIGIN}/toolbar`,
        html: page(
          "Toolbar",
          "Click the settings (gear) icon.",
          `<div class="row">
            <button id="search" aria-label="Search">🔍</button>
            <button id="bell" aria-label="Notifications">🔔</button>
            <button id="settings" class="target" aria-label="Settings">⚙️</button>
            <button id="profile" aria-label="Profile">👤</button>
          </div>`,
        ),
      },
    ],
  },
];
