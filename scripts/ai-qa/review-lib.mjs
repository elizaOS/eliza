/**
 * Pure logic for the AI-QA vision screenshot review (#9304).
 *
 * Today the "screenshot review" layer is a color-bucket + blank-detection
 * heuristic — it never looks at what the UI actually shows. This module is the
 * dependency-free core of a real content review: it builds the per-capture
 * vision prompt, parses the model's structured verdict, aggregates the run, and
 * decides the gate. The live model call + filesystem I/O live in
 * `review-screenshots.mjs`; everything here is pure so it is unit-tested without
 * a network or an API key.
 */

/** @typedef {"good" | "needs-work" | "broken"} VisionVerdict */

/**
 * Build the review prompt for one capture. `expectation` is the route's human
 * label (what the page is supposed to be); `issues` are the console/page errors
 * the capture already recorded (fed to the model as corroborating signal).
 * @param {{ label: string, path: string, viewport: string, theme: string, issues?: string[] }} capture
 */
export function buildReviewPrompt(capture) {
  const issues = (capture.issues ?? []).slice(0, 8);
  return [
    `You are reviewing a screenshot of the "${capture.label}" page (${capture.path}) of the elizaOS dashboard, captured at the ${capture.viewport} viewport in ${capture.theme} theme.`,
    "",
    "Judge what is ACTUALLY VISIBLE — not what should be there. Check for:",
    "- Render failure: blank/one-color, an error overlay, a stack trace, a spinner that never resolved, or obviously missing content for this page.",
    "- Layout breaks: overlapping elements, text clipped/cut off, content overflowing its container, a collapsed/zero-height region, controls off-screen.",
    "- Brand: the accent must be orange; there must be NO blue used as an accent/interactive color (neutral grays are fine). Flag any blue accent.",
    "- Usability: unreadable contrast, placeholder/lorem text, raw untranslated i18n keys (e.g. `common.save`), leaked markup (e.g. a literal `[CONFIG:` or `[TASK:` marker).",
    "",
    issues.length
      ? `The capture harness also recorded these console/page signals: ${JSON.stringify(issues)}.`
      : "The capture harness recorded no console/page errors.",
    "",
    'Respond with ONLY a JSON object, no prose, in this exact shape: {"verdict":"good"|"needs-work"|"broken","reasons":string[],"layoutIssues":string[],"brandViolations":string[],"detectedText":string}. Use "broken" for a render failure, "needs-work" for a real visual/brand/usability defect, "good" otherwise. Keep arrays empty when nothing applies.',
  ].join("\n");
}

const VALID_VERDICTS = new Set(["good", "needs-work", "broken"]);

/**
 * Parse a vision model's response into a typed verdict. Tolerates the model
 * wrapping the JSON in prose / code fences by extracting the first balanced
 * object. Throws on anything that is not a usable verdict (a parse failure is a
 * real signal — the review did not happen — not something to paper over).
 * @param {string} text
 */
export function parseVisionVerdict(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("vision-review: empty response");
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(
      `vision-review: no JSON object in response: ${text.slice(0, 120)}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`vision-review: unparseable JSON: ${err?.message || err}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !VALID_VERDICTS.has(parsed.verdict)
  ) {
    throw new Error(
      `vision-review: missing/invalid verdict: ${JSON.stringify(parsed).slice(0, 120)}`,
    );
  }
  const arr = (v) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  return {
    verdict: parsed.verdict,
    reasons: arr(parsed.reasons),
    layoutIssues: arr(parsed.layoutIssues),
    brandViolations: arr(parsed.brandViolations),
    detectedText:
      typeof parsed.detectedText === "string" ? parsed.detectedText : "",
  };
}

/** Aggregate per-capture results into run totals. */
export function aggregateVerdicts(results) {
  const totals = {
    total: results.length,
    good: 0,
    "needs-work": 0,
    broken: 0,
    error: 0,
  };
  for (const r of results) {
    const key = r.error ? "error" : r.verdict;
    if (key in totals) totals[key] += 1;
  }
  return totals;
}

/**
 * Gate decision: the captures that should fail the run. A `broken` verdict (or
 * an `error` — the review could not be obtained) fails unless its
 * `${id}-${viewport}-${theme}` key is in the shrinking debt allowlist. In strict
 * mode `needs-work` also fails. Mirrors the aesthetic-audit / story-gate ratchet.
 * @returns {Array<{key:string, verdict:string, reasons:string[]}>}
 */
export function gateFailures(results, { debt = {}, strict = false } = {}) {
  return results
    .filter((r) => {
      const fail =
        r.error ||
        r.verdict === "broken" ||
        (strict && r.verdict === "needs-work");
      return fail && debt[r.key] === undefined;
    })
    .map((r) => ({
      key: r.key,
      verdict: r.error ? "error" : r.verdict,
      reasons: r.error
        ? [String(r.error)]
        : [
            ...(r.reasons ?? []),
            ...(r.layoutIssues ?? []),
            ...(r.brandViolations ?? []),
          ],
    }));
}

/** The Anthropic image content block for a base64 PNG. */
export function imageBlock(base64Png) {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: base64Png },
  };
}
