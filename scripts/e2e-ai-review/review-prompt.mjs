/**
 * Reviewer-prompt assembly for the e2e AI review orchestrator (`run.mjs`):
 * turns one test's manifest plus its inlined artifact excerpts into the
 * single prompt a backend CLI receives, and validates the JSON verdict the
 * backend must emit in return. Pure string/data transforms — file reading and
 * spawning stay in the orchestrator — so the truncation, digest, and
 * verdict-parsing rules are unit-testable.
 *
 * Size discipline: logs are inlined tail-biased (failures live at the end of
 * console/network/server logs) capped at ~15KB each; trajectory prompts and
 * responses are inlined head-biased at 2KB per call (the instruction and the
 * opening of the answer carry the signal). Screenshots and videos are never
 * inlined — the prompt lists absolute paths the reviewer may open itself.
 */

/** Per-log inline cap. Tail-biased: the end of a log is where failures land. */
export const LOG_EXCERPT_CAP = 15 * 1024;

/** Per-field cap for trajectory prompt/response snippets. */
export const SNIPPET_CAP = 2 * 1024;

export const VERDICTS = ["pass", "fail", "flaky", "needs-eyeball"];
export const FINDING_SEVERITIES = ["blocker", "major", "minor"];
export const FINDING_AREAS = ["app", "test", "harness", "infra"];

/** Keep the tail of `text` within `cap` chars, with an explicit omission marker. */
export function tailExcerpt(text, cap = LOG_EXCERPT_CAP) {
  const source = String(text ?? "");
  if (source.length <= cap) return source;
  const omitted = source.length - cap;
  return `[... ${omitted} chars omitted; showing tail ...]\n${source.slice(-cap)}`;
}

/** Keep the head of `text` within `cap` chars, with an explicit omission marker. */
export function headSnippet(text, cap = SNIPPET_CAP) {
  const source = String(text ?? "");
  if (source.length <= cap) return source;
  const omitted = source.length - cap;
  return `${source.slice(0, cap)}\n[... ${omitted} chars omitted ...]`;
}

// Trajectory files vary by producer (jsonl per LLM call, or a JSON array /
// wrapper object). Parsing is tolerant on shape but explicit on failure:
// unparseable input yields { ok:false } (J3), never an empty digest that
// reads as "no LLM calls happened".
function parseTrajectoryRecords(raw) {
  const source = String(raw ?? "").trim();
  if (source.length === 0)
    return { ok: false, reason: "empty trajectory file" };
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return { ok: true, records: parsed };
    if (parsed !== null && typeof parsed === "object") {
      for (const key of ["calls", "steps", "events", "trajectory"]) {
        if (Array.isArray(parsed[key]))
          return { ok: true, records: parsed[key] };
      }
      return { ok: true, records: [parsed] };
    }
    return { ok: false, reason: "trajectory JSON is not an object or array" };
  } catch {
    // error-policy:J3 not whole-file JSON — fall through to jsonl parsing.
  }
  const records = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // error-policy:J3 untrusted producer line; skipped lines are counted
      // against the parse below so a fully-garbled file reports invalid.
    }
  }
  if (records.length === 0) {
    return { ok: false, reason: "no parseable JSON lines in trajectory file" };
  }
  return { ok: true, records };
}

function asText(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

/**
 * Digest a raw trajectory artifact into per-call summaries: model, prompt
 * head (2KB), response head (2KB), tool calls. Returns
 * `{ ok:true, text }` or `{ ok:false, reason }` — never a fabricated empty
 * digest for a broken file.
 */
export function digestTrajectory(raw) {
  const parsed = parseTrajectoryRecords(raw);
  if (!parsed.ok) return parsed;
  const sections = parsed.records.map((record, index) => {
    const model =
      record.model ??
      record.modelType ??
      record.modelKey ??
      "(model not recorded)";
    const prompt = asText(
      record.prompt ??
        record.input ??
        record.request?.prompt ??
        record.messages,
    );
    const response = asText(
      record.response ?? record.output ?? record.completion ?? record.result,
    );
    const toolCalls = record.toolCalls ?? record.tool_calls ?? [];
    const tools = Array.isArray(toolCalls)
      ? toolCalls
          .map(
            (call) =>
              call?.name ??
              call?.tool ??
              call?.function?.name ??
              "(unnamed tool)",
          )
          .join(", ")
      : asText(toolCalls);
    return [
      `--- LLM call ${index + 1} (model: ${asText(model)}) ---`,
      `prompt: ${headSnippet(prompt)}`,
      `response: ${headSnippet(response)}`,
      `tool calls: ${tools.length > 0 ? tools : "(none)"}`,
    ].join("\n");
  });
  return {
    ok: true,
    callCount: parsed.records.length,
    text: sections.join("\n"),
  };
}

/**
 * Digest a posthog-events artifact into an event-type histogram plus notable
 * (error/exception-flavored) events. Same explicit-invalid contract as
 * `digestTrajectory`.
 */
export function digestPosthogEvents(raw) {
  const parsed = parseTrajectoryRecords(raw);
  if (!parsed.ok) return parsed;
  const histogram = {};
  const notable = [];
  for (const record of parsed.records) {
    const eventName = asText(record.event ?? record.type ?? "(unnamed event)");
    histogram[eventName] = (histogram[eventName] ?? 0) + 1;
    if (/error|exception|fail/i.test(eventName)) {
      notable.push(headSnippet(JSON.stringify(record), 512));
    }
  }
  const histogramLines = Object.entries(histogram)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `  ${count}x ${name}`);
  const lines = ["event histogram:", ...histogramLines];
  if (notable.length > 0) {
    lines.push("notable events:", ...notable.map((entry) => `  ${entry}`));
  }
  return {
    ok: true,
    eventCount: parsed.records.length,
    text: lines.join("\n"),
  };
}

const OUTPUT_CONTRACT = `OUTPUT CONTRACT (strict):
Respond with a SINGLE JSON object and nothing else after it. Shape:
{
  "verdict": "pass" | "fail" | "flaky" | "needs-eyeball",
  "confidence": <number 0..1>,
  "findings": [
    {
      "severity": "blocker" | "major" | "minor",
      "area": "app" | "test" | "harness" | "infra",
      "summary": "<one-sentence defect statement>",
      "evidence": "<what in the artifacts shows it>",
      "suggestedFix": "<optional concrete fix>",
      "files": ["<optional repo-relative files the fix touches>"]
    }
  ],
  "notes": "<short overall assessment>"
}
Verdict meanings: pass = the test AND the app behavior it exercised are healthy;
fail = the artifacts show a real defect (in app, test, harness, or infra);
flaky = the failure pattern looks timing/environment dependent, not a stable defect;
needs-eyeball = the artifacts are insufficient or ambiguous — a human must look.`;

function section(title, body) {
  return `## ${title}\n${body}`;
}

/**
 * Assemble the full reviewer prompt for one test.
 *
 * `testEntry` is the test's manifest (contract shape `elizaos.e2e.test/1`).
 * `inlined` carries pre-read artifact content and paths:
 *   { consoleLog?, networkLog?, serverLog?, ocrText?, trajectoryRaw?,
 *     posthogEventsRaw?, screenshotPaths?: string[], videoPaths?: string[] }
 * Absent fields render as explicit "(not captured)" so the reviewer can tell
 * a missing artifact from an empty one.
 */
export function buildReviewPrompt(testEntry, inlined = {}) {
  if (!testEntry || typeof testEntry !== "object") {
    throw new Error("buildReviewPrompt: testEntry manifest is required");
  }
  const parts = [];
  parts.push(
    `You are a senior QA engineer + software engineer reviewing the COMPLETE artifact bundle of ONE end-to-end test run. Judge both the test outcome and whether the application behavior shown in the artifacts is actually correct. Be specific; cite the artifact that backs each finding.`,
  );
  parts.push(section("Test manifest", JSON.stringify(testEntry, null, 2)));

  const logSections = [
    ["Console log (tail excerpt)", inlined.consoleLog],
    ["Network log (tail excerpt)", inlined.networkLog],
    ["Server log (tail excerpt)", inlined.serverLog],
  ];
  for (const [title, content] of logSections) {
    parts.push(
      section(
        title,
        content !== undefined ? tailExcerpt(content) : "(not captured)",
      ),
    );
  }

  parts.push(
    section(
      "OCR text from screenshots",
      inlined.ocrText !== undefined
        ? tailExcerpt(inlined.ocrText)
        : "(not captured)",
    ),
  );

  if (inlined.trajectoryRaw !== undefined) {
    const digest = digestTrajectory(inlined.trajectoryRaw);
    parts.push(
      section(
        "LLM trajectory digest",
        digest.ok
          ? digest.text
          : `(trajectory artifact present but unparseable: ${digest.reason})`,
      ),
    );
  } else {
    parts.push(section("LLM trajectory digest", "(not captured)"));
  }

  if (inlined.posthogEventsRaw !== undefined) {
    const digest = digestPosthogEvents(inlined.posthogEventsRaw);
    parts.push(
      section(
        "PostHog events",
        digest.ok
          ? digest.text
          : `(posthog-events artifact present but unparseable: ${digest.reason})`,
      ),
    );
  } else {
    parts.push(section("PostHog events", "(not captured)"));
  }

  const screenshots = inlined.screenshotPaths ?? [];
  const videos = inlined.videoPaths ?? [];
  parts.push(
    section(
      "Visual artifacts you may open (absolute paths)",
      [
        screenshots.length > 0
          ? `screenshots:\n${screenshots.map((p) => `  ${p}`).join("\n")}`
          : "screenshots: (none)",
        videos.length > 0
          ? `videos:\n${videos.map((p) => `  ${p}`).join("\n")}`
          : "videos: (none)",
      ].join("\n"),
    ),
  );

  parts.push(OUTPUT_CONTRACT);
  return parts.join("\n\n");
}

/**
 * Validate an extracted reviewer verdict object against the output contract.
 * Strict on the load-bearing fields (verdict, confidence, finding severity /
 * area / summary); returns `{ ok:true, verdict }` with normalized optionals
 * or `{ ok:false, reason }` so the orchestrator can retry with a JSON nudge.
 */
export function parseReviewVerdict(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "verdict is not a JSON object" };
  }
  if (!VERDICTS.includes(value.verdict)) {
    return {
      ok: false,
      reason: `verdict must be one of ${VERDICTS.join("|")}`,
    };
  }
  if (
    typeof value.confidence !== "number" ||
    Number.isNaN(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    return { ok: false, reason: "confidence must be a number in [0,1]" };
  }
  // Models occasionally omit an empty findings array on a clean pass; treat
  // absence as [] but reject any present-but-wrong shape.
  const rawFindings = value.findings === undefined ? [] : value.findings;
  if (!Array.isArray(rawFindings)) {
    return { ok: false, reason: "findings must be an array" };
  }
  const findings = [];
  for (const [index, finding] of rawFindings.entries()) {
    if (finding === null || typeof finding !== "object") {
      return { ok: false, reason: `findings[${index}] is not an object` };
    }
    if (!FINDING_SEVERITIES.includes(finding.severity)) {
      return {
        ok: false,
        reason: `findings[${index}].severity must be one of ${FINDING_SEVERITIES.join("|")}`,
      };
    }
    if (!FINDING_AREAS.includes(finding.area)) {
      return {
        ok: false,
        reason: `findings[${index}].area must be one of ${FINDING_AREAS.join("|")}`,
      };
    }
    if (
      typeof finding.summary !== "string" ||
      finding.summary.trim().length === 0
    ) {
      return {
        ok: false,
        reason: `findings[${index}].summary must be non-empty`,
      };
    }
    const normalized = {
      severity: finding.severity,
      area: finding.area,
      summary: finding.summary,
      evidence: typeof finding.evidence === "string" ? finding.evidence : "",
    };
    if (
      typeof finding.suggestedFix === "string" &&
      finding.suggestedFix.length > 0
    ) {
      normalized.suggestedFix = finding.suggestedFix;
    }
    if (
      Array.isArray(finding.files) &&
      finding.files.every((file) => typeof file === "string")
    ) {
      normalized.files = finding.files;
    }
    findings.push(normalized);
  }
  return {
    ok: true,
    verdict: {
      verdict: value.verdict,
      confidence: value.confidence,
      findings,
      notes: typeof value.notes === "string" ? value.notes : "",
    },
  };
}
