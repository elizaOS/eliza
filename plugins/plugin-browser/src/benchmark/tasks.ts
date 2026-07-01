/**
 * MiniWoB++-style task suite for the plugin-browser benchmark (#9476).
 *
 * MiniWoB / MiniWoB++ (Shi et al. 2017, "World of Bits"; Liu et al. 2018) is the
 * canonical web-interaction agent benchmark. Each task here is faithful to that
 * format — a short natural-language `utterance` plus a self-contained DOM the
 * agent must manipulate — but rendered as **pure markup with no page scripts**,
 * because plugin-browser's web mode hard-blocks script execution
 * (GHSA-mhhr-9ph9-64j7). Reward is therefore computed from *observable* DOM
 * state (resulting URL/title, field values, checkbox states) read back through
 * real BROWSER `get` commands — never from in-page JS.
 *
 * Determinism: every task is parameterised by an integer `seed` via a small
 * splitmix/mulberry PRNG, so a suite run is fully reproducible (the committed
 * artifact is stable) while still varying targets across seeds.
 */

import type { BenchmarkAction, BenchmarkTask } from "./types.js";

/** Origin all task pages are served from (via the `network route` interceptor). */
export const WOB_ORIGIN = "https://wob.test";

/** Deterministic PRNG so a given seed always yields the same task instance. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length];
}

/** Render the shared task chrome: the `#wob-query` goal banner MiniWoB exposes. */
function page(title: string, query: string, body: string): string {
  return `<!doctype html>
<html>
  <head><title>${escapeHtml(title)}</title></head>
  <body>
    <div id="wob-query" data-role="query">${escapeHtml(query)}</div>
    <main id="area">${body}</main>
  </body>
</html>`;
}

function terminalPage(kind: "done" | "fail"): string {
  const title = kind === "done" ? "WOB SUCCESS" : "WOB FAIL";
  return page(
    title,
    title,
    `<h1 id="wob-${kind}">${title}</h1><p>episode reward = ${kind === "done" ? "1" : "0"}</p>`,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BUTTON_LABELS = [
  "ONE",
  "TWO",
  "THREE",
  "submit",
  "next",
  "cancel",
  "ok",
  "no",
] as const;
const LINK_LABELS = [
  "Details",
  "Home",
  "Pricing",
  "Contact",
  "Docs",
  "Blog",
] as const;
const WORDS = [
  "Kanon",
  "Lindsay",
  "Tobias",
  "Marlena",
  "orange",
  "harbor",
  "vivid",
  "lantern",
  "quartz",
  "meadow",
] as const;
const FRUITS = ["apple", "cherry", "lemon", "grape", "melon", "peach"] as const;

const DONE_URL = `${WOB_ORIGIN}/wob/done`;
const FAIL_URL = `${WOB_ORIGIN}/wob/fail`;

/** Terminal routes every navigation-scored task shares. */
function terminalRoutes(): ReadonlyArray<{ url: string; html: string }> {
  return [
    { url: DONE_URL, html: terminalPage("done") },
    { url: FAIL_URL, html: terminalPage("fail") },
  ];
}

// ── click-button ──────────────────────────────────────────────────────────
// Click the button with the target label. Implemented as anchor "buttons" so a
// click is observable through navigation (web mode has no JS to fire handlers).
const clickButton: BenchmarkTask = {
  id: "click-button",
  family: "miniwob++",
  description: "Click the button carrying the labelled text.",
  maxSteps: 4,
  utterance(seed) {
    const rng = mulberry32(seed);
    return `Click the button labelled "${pick(rng, BUTTON_LABELS)}".`;
  },
  build(seed) {
    const rng = mulberry32(seed);
    const target = pick(rng, BUTTON_LABELS);
    const labels = Array.from(new Set([target, ...BUTTON_LABELS])).slice(0, 4);
    const buttons = labels
      .map((label, i) => {
        const href = label === target ? "/wob/done" : "/wob/fail";
        return `<a id="btn-${i}" role="button" class="wob-btn" href="${href}">${escapeHtml(label)}</a>`;
      })
      .join("\n      ");
    return {
      startUrl: `${WOB_ORIGIN}/click-button`,
      routes: [
        {
          url: `${WOB_ORIGIN}/click-button`,
          html: page(
            "Click Button",
            `Click the button labelled "${target}".`,
            buttons,
          ),
        },
        ...terminalRoutes(),
      ],
    };
  },
  oracle(seed) {
    const rng = mulberry32(seed);
    const target = pick(rng, BUTTON_LABELS);
    const labels = Array.from(new Set([target, ...BUTTON_LABELS])).slice(0, 4);
    const idx = labels.indexOf(target);
    return [
      { type: "click", selector: `#btn-${idx}`, note: `button "${target}"` },
    ];
  },
  async reward(ctx) {
    return (await ctx.getUrl()) === DONE_URL ? 1 : 0;
  },
};

// ── click-link ──────────────────────────────────────────────────────────
const clickLink: BenchmarkTask = {
  id: "click-link",
  family: "miniwob++",
  description: "Click the hyperlink with the target text.",
  maxSteps: 4,
  utterance(seed) {
    const rng = mulberry32(seed);
    return `Click the link "${pick(rng, LINK_LABELS)}".`;
  },
  build(seed) {
    const rng = mulberry32(seed);
    const target = pick(rng, LINK_LABELS);
    const labels = Array.from(new Set([target, ...LINK_LABELS])).slice(0, 4);
    const links = labels
      .map((label, i) => {
        const href = label === target ? "/wob/done" : "/wob/fail";
        return `<a id="lnk-${i}" href="${href}">${escapeHtml(label)}</a>`;
      })
      .join(" · ");
    return {
      startUrl: `${WOB_ORIGIN}/click-link`,
      routes: [
        {
          url: `${WOB_ORIGIN}/click-link`,
          html: page(
            "Click Link",
            `Click the link "${target}".`,
            `<p id="copy">Pick the right one: ${links}</p>`,
          ),
        },
        ...terminalRoutes(),
      ],
    };
  },
  oracle(seed) {
    const rng = mulberry32(seed);
    const target = pick(rng, LINK_LABELS);
    const labels = Array.from(new Set([target, ...LINK_LABELS])).slice(0, 4);
    return [
      {
        type: "click",
        selector: `#lnk-${labels.indexOf(target)}`,
        note: `link "${target}"`,
      },
    ];
  },
  async reward(ctx) {
    return (await ctx.getUrl()) === DONE_URL ? 1 : 0;
  },
};

// ── enter-text ──────────────────────────────────────────────────────────
// Type a fixed target string into the field; reward = field value matches.
const enterText: BenchmarkTask = {
  id: "enter-text",
  family: "miniwob++",
  description: "Enter the requested text into the field and submit.",
  maxSteps: 4,
  utterance(seed) {
    const rng = mulberry32(seed);
    return `Enter "${pick(rng, WORDS)}" into the text field and press Submit.`;
  },
  build(seed) {
    const rng = mulberry32(seed);
    const target = pick(rng, WORDS);
    return {
      startUrl: `${WOB_ORIGIN}/enter-text`,
      // Submit is a non-navigating button (no JS, no action) so the field
      // persists for reward inspection — MiniWoB scores the entered value.
      routes: [
        {
          url: `${WOB_ORIGIN}/enter-text`,
          html: page(
            "Enter Text",
            `Enter "${target}" into the text field and press Submit.`,
            // No <form> wrapper: web mode submits (and reloads, wiping the
            // field) on ANY button click inside a form, even type="button".
            // MiniWoB scores the entered value, so the field must persist.
            `<input id="tt" name="tt" type="text" value="" />
      <button id="submit" type="button">Submit</button>`,
          ),
        },
      ],
    };
  },
  oracle(seed) {
    const rng = mulberry32(seed);
    const target = pick(rng, WORDS);
    return [
      {
        type: "type",
        selector: "#tt",
        value: target,
        note: `enter "${target}"`,
      },
      { type: "click", selector: "#submit", note: "submit" },
    ];
  },
  async reward(ctx, seed) {
    const rng = mulberry32(seed);
    const target = pick(rng, WORDS);
    return (await ctx.getValue("#tt")) === target ? 1 : 0;
  },
};

// ── enter-text-dynamic ────────────────────────────────────────────────────
// Target string is generated per-seed (MiniWoB enter-text-dynamic): the agent
// must read it from the page, not memorise a fixed answer.
const enterTextDynamic: BenchmarkTask = {
  id: "enter-text-dynamic",
  family: "miniwob++",
  description: "Enter the dynamically-generated token shown in the prompt.",
  maxSteps: 4,
  utterance(seed) {
    return `Enter "${dynamicToken(seed)}" into the text field and press Submit.`;
  },
  build(seed) {
    const target = dynamicToken(seed);
    return {
      startUrl: `${WOB_ORIGIN}/enter-text-dynamic`,
      routes: [
        {
          url: `${WOB_ORIGIN}/enter-text-dynamic`,
          html: page(
            "Enter Text Dynamic",
            `Enter "${target}" into the text field and press Submit.`,
            // See enter-text: keep the field outside a <form> so the Submit
            // click does not reload and wipe the entered value.
            `<input id="tt" name="tt" type="text" value="" />
      <button id="submit" type="button">Submit</button>`,
          ),
        },
      ],
    };
  },
  oracle(seed) {
    const target = dynamicToken(seed);
    return [
      {
        type: "type",
        selector: "#tt",
        value: target,
        note: `enter "${target}"`,
      },
      { type: "click", selector: "#submit", note: "submit" },
    ];
  },
  async reward(ctx, seed) {
    return (await ctx.getValue("#tt")) === dynamicToken(seed) ? 1 : 0;
  },
};

function dynamicToken(seed: number): string {
  const rng = mulberry32(seed * 2654435761);
  const word = pick(rng, WORDS);
  const num = Math.floor(rng() * 900 + 100);
  return `${word}${num}`;
}

// ── click-checkboxes ──────────────────────────────────────────────────────
// Check exactly the target subset; leave the rest unchecked.
const clickCheckboxes: BenchmarkTask = {
  id: "click-checkboxes",
  family: "miniwob++",
  description: "Select exactly the requested checkboxes and no others.",
  maxSteps: 8,
  utterance(seed) {
    return `Select ${checkboxTargets(seed).join(", ")}. Leave the rest unchecked.`;
  },
  build(seed) {
    const targets = new Set(checkboxTargets(seed));
    const boxes = FRUITS.map(
      (label, i) =>
        `<label><input id="cb-${i}" type="checkbox" /> ${escapeHtml(label)}</label>`,
    ).join("<br/>\n      ");
    return {
      startUrl: `${WOB_ORIGIN}/click-checkboxes`,
      routes: [
        {
          url: `${WOB_ORIGIN}/click-checkboxes`,
          html: page(
            "Click Checkboxes",
            `Select ${[...targets].join(", ")}. Leave the rest unchecked.`,
            `<form id="form">${boxes}</form>`,
          ),
        },
      ],
    };
  },
  oracle(seed) {
    const targets = new Set(checkboxTargets(seed));
    const actions: BenchmarkAction[] = [];
    FRUITS.forEach((label, i) => {
      if (targets.has(label)) {
        actions.push({
          type: "check",
          selector: `#cb-${i}`,
          note: `check ${label}`,
        });
      }
    });
    return actions;
  },
  async reward(ctx, seed) {
    const targets = new Set(checkboxTargets(seed));
    for (let i = 0; i < FRUITS.length; i++) {
      const want = targets.has(FRUITS[i]);
      const got = await ctx.getChecked(`#cb-${i}`);
      if (got !== want) return 0;
    }
    return 1;
  },
};

function checkboxTargets(seed: number): string[] {
  const rng = mulberry32(seed * 40503);
  const count = 1 + Math.floor(rng() * 2); // 1..2 targets
  const shuffled = [...FRUITS].sort(() => rng() - 0.5);
  return shuffled.slice(0, count).sort();
}

// ── multistep-purchase ────────────────────────────────────────────────────
// A genuine multi-page flow: home → catalog → buy. Proves the harness drives
// navigation end-to-end through real BROWSER commands, not a single click.
const multistepPurchase: BenchmarkTask = {
  id: "multistep-purchase",
  family: "miniwob++",
  description: "Navigate home → catalog → buy across multiple routed pages.",
  maxSteps: 6,
  utterance() {
    return "Open the catalog, then buy the featured item.";
  },
  build(seed) {
    const rng = mulberry32(seed * 19349663);
    const distractors = Array.from({ length: 3 }, (_, i) => {
      const label = pick(rng, LINK_LABELS);
      return `<a id="cat-${i}" href="/wob/fail">${escapeHtml(label)}</a>`;
    }).join(" · ");
    return {
      startUrl: `${WOB_ORIGIN}/shop`,
      routes: [
        {
          url: `${WOB_ORIGIN}/shop`,
          html: page(
            "Shop Home",
            "Open the catalog, then buy the featured item.",
            `<a id="go-catalog" href="/catalog">Open catalog</a>`,
          ),
        },
        {
          url: `${WOB_ORIGIN}/catalog`,
          html: page(
            "Catalog",
            "Buy the featured item.",
            `<p>${distractors}</p><a id="buy" href="/wob/done">Buy featured item</a>`,
          ),
        },
        ...terminalRoutes(),
      ],
    };
  },
  oracle() {
    return [
      { type: "click", selector: "#go-catalog", note: "open catalog" },
      { type: "click", selector: "#buy", note: "buy featured item" },
    ];
  },
  async reward(ctx) {
    return (await ctx.getUrl()) === DONE_URL ? 1 : 0;
  },
};

/** The MiniWoB++ subset wired through plugin-browser. */
export const MINIWOB_TASKS: readonly BenchmarkTask[] = [
  clickButton,
  clickLink,
  enterText,
  enterTextDynamic,
  clickCheckboxes,
  multistepPurchase,
];

export function getTaskById(id: string): BenchmarkTask | undefined {
  return MINIWOB_TASKS.find((t) => t.id === id);
}
