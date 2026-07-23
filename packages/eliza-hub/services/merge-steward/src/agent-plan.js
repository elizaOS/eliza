import { verifyAgentRunReceipt } from "./agent-run-receipt.js";

const PLAN_HEADINGS = Object.freeze([
  "plan",
  "approach",
  "implementation plan",
  "execution plan",
]);
const VALIDATION_HEADINGS = Object.freeze([
  "validation",
  "verification",
  "test plan",
  "tests",
  "how tested",
]);
const AGENT_RUN_HEADINGS = Object.freeze([
  "agent run",
  "agent run receipt",
  "run receipt",
  "eliza run",
]);

export function detectAgentPlanSignals(text = "", options = {}) {
  const agentRun = detectAgentRunReceipt(text, options);
  return {
    hasExecutionPlan: hasHeading(text, PLAN_HEADINGS),
    hasValidationPlan: hasHeading(text, VALIDATION_HEADINGS),
    ...(agentRun ? { agentRun } : {}),
  };
}

export function detectAgentRunReceipt(text = "", options = {}) {
  const section = findHeadingSection(text, AGENT_RUN_HEADINGS);
  if (!section) return null;

  const runId = readKeyValue(section, ["runId", "run id", "id"]);
  const state = normalizeRunState(readKeyValue(section, ["state", "status"]));
  const failedChildren = readInteger(section, [
    "failedChildren",
    "failed children",
    "failed child count",
  ]);
  const failedChildKeys = readList(section, [
    "failedChildKeys",
    "failed child keys",
  ]);
  const url = readKeyValue(section, ["url", "link"]);
  const updatedAt = readKeyValue(section, [
    "updatedAt",
    "updated at",
    "computedAt",
    "computed at",
  ]);
  const signature = readKeyValue(section, [
    "signature",
    "hmac",
    "receiptSignature",
    "receipt signature",
  ]);

  if (
    !runId &&
    !state &&
    failedChildren == null &&
    failedChildKeys.length === 0 &&
    !url &&
    !updatedAt &&
    !signature
  ) {
    return null;
  }

  const receipt = dropUndefined({
    runId,
    state,
    failedChildren,
    failedChildKeys: failedChildKeys.length > 0 ? failedChildKeys : undefined,
    url,
    updatedAt,
    signature,
  });
  return options.verify === false
    ? receipt
    : verifyAgentRunReceipt(receipt, options);
}

function hasHeading(text, headings) {
  const value = String(text ?? "");
  return headings.some((heading) => headingPattern(heading).test(value));
}

function headingPattern(heading) {
  const escaped = heading
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(
    String.raw`(^|\n)\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?(?:#{1,6}\s*)?(?:\*\*)?${escaped}(?:\*\*)?\s*:?(?=\s|$)`,
    "i",
  );
}

function findHeadingSection(text, headings) {
  const lines = String(text ?? "").split(/\r?\n/);
  const collected = [];
  let inSection = false;

  for (const line of lines) {
    if (headings.some((heading) => headingPattern(heading).test(line))) {
      inSection = true;
      continue;
    }

    if (inSection && isSectionHeading(line)) {
      break;
    }

    if (inSection) {
      collected.push(line);
    }
  }

  const section = collected.join("\n").trim();
  return section || null;
}

function readKeyValue(text, keys) {
  const escapedKeys = keys.map((key) =>
    key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
  );
  const pattern = new RegExp(
    String.raw`(^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(?:${escapedKeys.join("|")})(?:\*\*)?\s*[:=]\s*([^\n]+)`,
    "i",
  );
  const match = pattern.exec(text);
  return match ? cleanValue(match[2]) : null;
}

function readInteger(text, keys) {
  const raw = readKeyValue(text, keys);
  if (raw == null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readList(text, keys) {
  const raw = readKeyValue(text, keys);
  if (!raw) return [];
  return raw
    .split(/[, ]+/)
    .map((item) => cleanValue(item))
    .filter(Boolean);
}

function normalizeRunState(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase().replace(/_/g, "-");
}

function cleanValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/^["'`]+|["'`,]+$/g, "");
}

function isSectionHeading(line) {
  const value = String(line ?? "").trim();
  if (!value) return false;
  if (/^#{1,6}\s+\S/.test(value)) return true;
  return /^(?:\*\*)?[A-Z][A-Za-z0-9 /_-]{1,64}(?:\*\*)?\s*:?\s*$/.test(value);
}

function dropUndefined(input) {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
}
