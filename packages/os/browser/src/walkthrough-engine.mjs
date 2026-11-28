/**
 * Site-agnostic Observe -> Plan -> Gate -> Act/Guide -> Verify -> HITL-Commit
 * browser walkthrough engine for arbitrary web tasks. Zero site-specific rules,
 * zero hardcoded model IDs, zero external dependencies beyond page-command.mjs.
 */
import {
  classifyActionConsequence,
  dismissBlockerCommand,
  pageCommand,
} from "./page-command.mjs";

export const WALKTHROUGH_PHASES = Object.freeze([
  "idle",
  "observing",
  "planning",
  "acting",
  "verifying",
  "paused_handoff",
  "completed",
  "blocked",
  "failed",
]);

export const HANDOFF_KINDS = Object.freeze([
  "NeedsPrivateSignIn",
  "NeedsMFA",
  "NeedsCaptcha",
  "NeedsFileUpload",
  "NeedsCommitApproval",
  "NeedsUserDisambiguation",
  "NeedsUntrustedOriginApproval",
]);

export const CONSEQUENCE_CLASSES = Object.freeze([
  "observe",
  "navigate",
  "stage",
  "commit",
  "person_only",
]);

const TWO_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "org.au",
  "gov.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "com.mx",
  "co.in",
  "com.sg",
  "com.hk",
  "co.za",
  "com.cn",
  "co.kr",
  "com.tw",
]);

const SECRET_QUERY_KEY =
  /^(?:token|access_token|id_token|refresh_token|api_key|apikey|key|secret|password|passwd|pwd|pass|code|otp|auth|session|sid|ssn|cvv|cvc|pin)$/i;

const luhnValid = (digits) => {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};

/**
 * Redacts credentials, tokens, SSNs, and Luhn-valid payment card numbers while
 * preserving ordinary numbers such as order IDs, amounts, dates and ZIP codes.
 */
export function redactSensitiveText(input) {
  if (typeof input !== "string" || input.length === 0) return input ?? "";
  let out = input;
  // Bearer / API keys
  out = out.replace(
    /\b(?:Bearer\s+[A-Za-z0-9._~+/-]{12,}|(?:sk|pk|csk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{12,})\b/gi,
    "[redacted-secret]",
  );
  // Secret URL query parameters
  out = out.replace(
    /([?&])([A-Za-z0-9_.-]+)=([^&#\s]+)/g,
    (match, sep, key) =>
      SECRET_QUERY_KEY.test(key) ? `${sep}${key}=[redacted]` : match,
  );
  // US SSN format NNN-NN-NNNN
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted-ssn]");
  // Luhn-valid 13-19 digit payment card numbers (with optional spaces or hyphens)
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (candidate) => {
    const digits = candidate.replace(/\D/g, "");
    return luhnValid(digits) ? "[redacted-card]" : candidate;
  });
  return out;
}

/** Strips query strings, fragments, and embedded credentials for zero-PII telemetry. */
export function stripUrlQuery(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return redactSensitiveText(rawUrl).split(/[?#]/)[0] ?? "";
  }
}

const isLoopbackHost = (host) =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]";

const registrableSiteOf = (host) => {
  const clean = (host || "").toLowerCase().replace(/\.$/, "");
  if (!clean || /^[\d.]+$/.test(clean) || clean.includes(":")) return null;
  const labels = clean.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_LABEL_SUFFIXES.has(lastTwo))
    return labels.length >= 3 ? labels.slice(-3).join(".") : null;
  return lastTwo;
};

/** Checks whether targetUrl is permitted under currentOrigin + allowedOrigins / same-site policy. */
export function isOriginAllowed(
  targetUrl,
  { currentOrigin, allowedOrigins = [], allowSameSiteSubdomains = false } = {},
) {
  try {
    const target = new URL(targetUrl);
    if (target.username || target.password) return false;
    if (!["https:", "http:"].includes(target.protocol)) return false;
    const base = currentOrigin ? new URL(currentOrigin) : null;
    if (
      target.protocol === "http:" &&
      !(base?.protocol === "http:" && isLoopbackHost(target.hostname))
    )
      return false;
    if (base && target.origin === base.origin) return true;
    if (allowedOrigins.includes(target.origin)) return true;
    if (allowSameSiteSubdomains && base && target.protocol === base.protocol) {
      const a = registrableSiteOf(target.hostname);
      const b = registrableSiteOf(base.hostname);
      if (a && a === b) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const normalizeWhitespace = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const fnv1aHash = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/**
 * Pure deterministic consequence classifier extending `classifyActionConsequence`
 * with `person_only` separation for sensitive credential/PII/MFA/file fields.
 */
export function classifyElementConsequence(
  element,
  { action = "click", hasPaymentCredentialField = false, commitPattern = null } = {},
) {
  if (!element || typeof element !== "object") {
    return {
      consequenceClass: "observe",
      reasons: ["missing-element"],
      requiresGrant: false,
    };
  }
  const tag = String(element.tag ?? "").toLowerCase();
  const type = String(element.type ?? "").toLowerCase();
  const sensitive = element.sensitive ?? null;
  if (tag === "input" && type === "file") {
    return {
      consequenceClass: "person_only",
      reasons: ["file-upload"],
      requiresGrant: true,
      handoffKind: "NeedsFileUpload",
    };
  }
  if (sensitive === "password" || (tag === "input" && type === "password")) {
    return {
      consequenceClass: "person_only",
      reasons: ["password-field"],
      requiresGrant: true,
      handoffKind: "NeedsPrivateSignIn",
    };
  }
  if (sensitive === "one-time-code") {
    return {
      consequenceClass: "person_only",
      reasons: ["verification-code"],
      requiresGrant: true,
      handoffKind: "NeedsMFA",
    };
  }
  if (
    sensitive === "payment-card" ||
    sensitive === "bank-account" ||
    sensitive === "government-id"
  ) {
    return {
      consequenceClass: "person_only",
      reasons: [`sensitive-${sensitive}`],
      requiresGrant: true,
      handoffKind: "NeedsPrivateSignIn",
    };
  }
  const base = classifyActionConsequence(
    {
      action,
      tag: element.tag,
      type: element.type,
      role: element.role,
      label: element.label || element.inferredLabel || "",
      submits: element.submits === true,
      sensitive: element.sensitive ?? null,
      scrollOnly: element.scrollOnly === true,
      hasHref: typeof element.href === "string" && element.href.length > 0,
      discloses: element.expanded !== undefined,
      contentEditable: element.contentEditable === true,
    },
    { hasPaymentCredentialField, commitPattern },
  );
  if (
    action === "click" &&
    element.consequence === "commit" &&
    base.consequence !== "commit"
  ) {
    return {
      consequenceClass: "commit",
      reasons: [...base.reasons, "dom-consequence-commit"],
      requiresGrant: true,
      handoffKind: "NeedsCommitApproval",
    };
  }
  return {
    consequenceClass: base.consequence,
    reasons: base.reasons,
    requiresGrant: base.requiresGrant,
    ...(base.consequence === "commit"
      ? { handoffKind: "NeedsCommitApproval" }
      : {}),
  };
}

/**
 * Extracts site-agnostic dark-pattern signals from a snapshot, merging
 * `structuredRegions.darkPatterns` with deterministic element/blocker fallback.
 */
export function detectDarkPatterns(snapshot) {
  const flags = [];
  const seen = new Set();
  const push = (flag) => {
    const key = `${flag.kind}:${flag.ref ?? flag.dismissRef ?? ""}:${String(flag.text ?? "").slice(0, 60)}`;
    if (seen.has(key)) return;
    seen.add(key);
    flags.push({
      ...flag,
      text: redactSensitiveText(String(flag.text ?? "")),
    });
  };
  for (const item of snapshot?.structuredRegions?.darkPatterns ?? []) push(item);
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const OPTIN =
    /\b(?:auto[- ]?pay|automatic\s+pay(?:ment)?s?|paperless|subscribe|subscription|membership|free\s+trial|protection\s+plan|warranty|marketing|promotional|newsletter|upgrade|add[- ]?on)\b/i;
  const RECURRING =
    /\b(?:subscribe\s*(?:&|and)\s*save|auto[- ]?deliver|recurring|monthly\s+plan|subscription|auto[- ]?renew)\b/i;
  const ONETIME =
    /\b(?:one[- ]?time|single\s+purchase|standard\s+purchase|pay\s+once)\b/i;
  const UPSELL =
    /\b(?:auto[- ]?pay|automatic\s+pay|free\s+trial|upgrade|protection\s+plan|subscribe|membership|paperless|special\s+offer|save\s+with\s+membership|try\s+(?:free\s+)?(?:membership|plus|pro))\b/i;
  for (const el of elements) {
    if (!el || el.scrollOnly) continue;
    const label = normalizeWhitespace(
      [el.label, el.inferredLabel, el.nearbyText, el.group].filter(Boolean).join(" "),
    );
    const isCheckbox =
      (el.tag === "input" && el.type === "checkbox") ||
      el.role === "checkbox" ||
      el.role === "switch";
    if (isCheckbox && el.checked === true && el.edited !== true && OPTIN.test(label)) {
      push({
        kind: "pre-checked-opt-in",
        ref: el.id ?? el.selector,
        targetSelector: el.targetSelector,
        label: el.label || el.inferredLabel || el.nearbyText || null,
        text: label.slice(0, 180),
      });
    }
  }
  const radios = elements.filter(
    (el) =>
      (el.tag === "input" && el.type === "radio") || el.role === "radio",
  );
  for (const radio of radios) {
    if (radio.checked !== true || radio.edited === true) continue;
    const text = normalizeWhitespace(
      [radio.label, radio.inferredLabel, radio.nearbyText].filter(Boolean).join(" "),
    );
    if (
      RECURRING.test(text) &&
      radios.some(
        (other) =>
          other !== radio &&
          ONETIME.test(
            normalizeWhitespace(
              [other.label, other.inferredLabel, other.nearbyText]
                .filter(Boolean)
                .join(" "),
            ),
          ),
      )
    ) {
      push({
        kind: "recurring-default",
        ref: radio.id ?? radio.selector,
        targetSelector: radio.targetSelector,
        label: radio.label || radio.inferredLabel || null,
        text: text.slice(0, 180),
      });
    }
  }
  for (const blocker of snapshot?.blockers ?? []) {
    if (blocker?.kind === "modal" && UPSELL.test(String(blocker.text ?? ""))) {
      push({
        kind: "upsell-modal",
        ...(blocker.ref ? { dismissRef: blocker.ref } : {}),
        text: String(blocker.text).slice(0, 180),
      });
    }
  }
  return flags;
}

/**
 * Produces a bounded, zero-PII semantic page observation for the planner with
 * unambiguous short bracketed refs (`e0`, `e1`, ...). Never leaks credentials
 * or oversized DOM payloads (e.g. 40-161KB SPA tabs).
 */
export function sanitizeObservationForPlanner(
  snapshot,
  {
    maxTextChars = 6000,
    maxControls = 80,
    maxCards = 24,
    maxTableRows = 20,
    includeReadOnly = false,
  } = {},
) {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const hasPaymentCredentialField = elements.some((el) =>
    ["payment-card", "bank-account"].includes(el?.sensitive),
  );
  const darkPatterns = detectDarkPatterns(snapshot);
  const rawIdToShortRef = new Map();
  const refToElement = new Map();
  const controls = [];
  let refCounter = 0;

  const eligible = [];
  for (let idx = 0; idx < elements.length; idx++) {
    const el = elements[idx];
    if (!el || el.scrollOnly) continue;
    if (
      !includeReadOnly &&
      el.readOnly === true &&
      (el.tag === "input" || el.tag === "textarea")
    )
      continue;
    eligible.push({ el, idx });
  }
  let selectedEntries = eligible;
  let truncatedControls = 0;
  if (eligible.length > maxControls) {
    const inView = eligible.filter(({ el }) => el.inViewport !== false);
    const offscreen = eligible.filter(({ el }) => el.inViewport === false);
    selectedEntries = [...inView, ...offscreen]
      .slice(0, maxControls)
      .sort((a, b) => a.idx - b.idx);
    truncatedControls = eligible.length - selectedEntries.length;
  }

  for (const { el } of selectedEntries) {
    const ref = `e${refCounter++}`;
    refToElement.set(ref, el);
    if (typeof el.id === "string") rawIdToShortRef.set(el.id, ref);
    if (typeof el.selector === "string") rawIdToShortRef.set(el.selector, ref);
    const classified = classifyElementConsequence(el, {
      action:
        el.tag === "select" ||
        el.role === "combobox" ||
        el.role === "listbox" ||
        el.role === "radiogroup"
          ? "select"
          : (el.tag === "input" &&
                ![
                  "button",
                  "submit",
                  "reset",
                  "image",
                  "checkbox",
                  "radio",
                ].includes(String(el.type ?? "").toLowerCase())) ||
              el.tag === "textarea" ||
              el.contentEditable === true ||
              el.role === "textbox" ||
              el.role === "searchbox"
            ? "fill"
            : "click",
      hasPaymentCredentialField,
    });
    const bestLabel = redactSensitiveText(
      normalizeWhitespace(
        el.label ||
          el.inferredLabel ||
          el.nearbyText ||
          el.placeholder ||
          el.title ||
          el.imageText ||
          "",
      ),
    ).slice(0, 140);
    const control = {
      ref,
      tag: el.tag,
      ...(el.role ? { role: el.role } : {}),
      ...(el.type ? { type: el.type } : {}),
      ...(el.contentEditable ? { contentEditable: true } : {}),
      label: bestLabel,
      consequence: classified.consequenceClass,
      ...(el.disabled ? { disabled: true } : {}),
      ...(el.readOnly ? { readOnly: true } : {}),
      ...(el.checked !== undefined ? { checked: el.checked } : {}),
      ...(el.selected !== undefined ? { selected: el.selected } : {}),
      ...(el.pressed !== undefined ? { pressed: el.pressed } : {}),
      ...(el.expanded !== undefined ? { expanded: el.expanded } : {}),
      ...(el.current ? { current: el.current } : {}),
      ...(el.required ? { required: true } : {}),
      ...(el.invalid ? { invalid: true } : {}),
      ...(el.hasInput !== undefined ? { hasInput: el.hasInput } : {}),
      ...(el.sensitive ? { sensitive: el.sensitive } : {}),
      ...(el.selectedLabel
        ? { selectedLabel: redactSensitiveText(el.selectedLabel) }
        : {}),
      ...(Array.isArray(el.options) && el.options.length > 0
        ? {
            options: el.options.slice(0, 25).map((opt) => ({
              label: redactSensitiveText(String(opt.label ?? "")),
              ...(opt.selected ? { selected: true } : {}),
              ...(opt.disabled ? { disabled: true } : {}),
            })),
          }
        : {}),
      ...(el.fileInput ? { fileInput: el.fileInput } : {}),
      ...(el.group ? { group: redactSensitiveText(el.group).slice(0, 80) } : {}),
      ...(el.rowText
        ? { rowText: redactSensitiveText(el.rowText).slice(0, 160) }
        : {}),
      ...(el.description
        ? { description: redactSensitiveText(el.description).slice(0, 120) }
        : {}),
      ...(el.href ? { hrefOriginPath: stripUrlQuery(el.href) } : {}),
      ...(el.inViewport === false ? { offscreen: true } : {}),
      ...(el.inShadowRoot ? { inShadowRoot: true } : {}),
      ...(el.frame ? { frameIndex: el.frame.index } : {}),
    };
    controls.push(control);
  }

  const mapRef = (raw) =>
    typeof raw === "string" ? (rawIdToShortRef.get(raw) ?? raw) : undefined;

  const sr = snapshot?.structuredRegions;
  const headings = Array.isArray(sr?.headings)
    ? sr.headings.slice(0, 32).map((h) => ({
        level: h.level,
        text: redactSensitiveText(h.text),
        ...(h.frameIndex !== undefined ? { frameIndex: h.frameIndex } : {}),
      }))
    : [];
  const landmarks = Array.isArray(sr?.landmarks)
    ? sr.landmarks.slice(0, 20).map((lm) => ({
        role: lm.role,
        ...(lm.label ? { label: redactSensitiveText(lm.label) } : {}),
        ...(lm.heading ? { heading: redactSensitiveText(lm.heading) } : {}),
        actionRefs: (lm.actionRefs ?? []).map(mapRef).filter(Boolean).slice(0, 8),
        ...(lm.frameIndex !== undefined ? { frameIndex: lm.frameIndex } : {}),
      }))
    : [];
  const tables = Array.isArray(sr?.tables)
    ? sr.tables.slice(0, 8).map((tbl) => ({
        ...(tbl.caption ? { caption: redactSensitiveText(tbl.caption) } : {}),
        ...(tbl.heading ? { heading: redactSensitiveText(tbl.heading) } : {}),
        columns: (tbl.columns ?? []).map(redactSensitiveText),
        rows: (tbl.rows ?? []).slice(0, maxTableRows).map((row) => ({
          cells: (row.cells ?? []).map(redactSensitiveText),
          actionRefs: (row.actionRefs ?? []).map(mapRef).filter(Boolean),
        })),
        rowCount: tbl.rowCount ?? tbl.rows?.length ?? 0,
        ...(tbl.frameIndex !== undefined ? { frameIndex: tbl.frameIndex } : {}),
      }))
    : [];
  const cards = Array.isArray(sr?.cards)
    ? sr.cards.slice(0, maxCards).map((card) => ({
        ...(card.heading ? { heading: redactSensitiveText(card.heading) } : {}),
        textLines: (card.textLines ?? []).map(redactSensitiveText),
        ...(card.badges?.length ? { badges: card.badges } : {}),
        actionRefs: (card.actionRefs ?? []).map(mapRef).filter(Boolean),
        ...(card.darkPatterns?.length ? { darkPatterns: card.darkPatterns } : {}),
        ...(card.frameIndex !== undefined ? { frameIndex: card.frameIndex } : {}),
      }))
    : [];
  const fileInputs = Array.isArray(sr?.fileInputs)
    ? sr.fileInputs.map((fi) => ({
        ref: mapRef(fi.ref) ?? null,
        triggerRef: mapRef(fi.triggerRef) ?? null,
        label: redactSensitiveText(fi.label),
        accept: fi.accept ?? null,
        multiple: fi.multiple === true,
        hasFiles: fi.hasFiles === true,
        fileCount: fi.fileCount ?? 0,
      }))
    : elements
        .filter((el) => el.tag === "input" && el.type === "file")
        .map((el) => ({
          ref: mapRef(el.id ?? el.selector) ?? null,
          triggerRef: mapRef(el.id ?? el.selector) ?? null,
          label: redactSensitiveText(el.label || el.inferredLabel || "File upload"),
          accept: el.fileInput?.accept ?? null,
          multiple: el.fileInput?.multiple === true,
          hasFiles: el.fileInput?.hasFiles === true,
          fileCount: el.fileInput?.fileCount ?? 0,
        }));
  const blockers = (Array.isArray(snapshot?.blockers) ? snapshot.blockers : []).map(
    (b) => ({
      kind: b.kind,
      covers: b.covers,
      overlay: b.overlay === true,
      autoDismissible:
        b.kind === "cookie-consent"
          ? Boolean(b.rejectRef)
          : b.kind !== "captcha" && b.kind !== "paywall" && Boolean(b.ref),
      ...(b.ref ? { ref: mapRef(b.ref) } : {}),
      ...(b.rejectRef ? { rejectRef: mapRef(b.rejectRef) } : {}),
      ...(b.text ? { text: redactSensitiveText(b.text).slice(0, 180) } : {}),
    }),
  );
  const mappedDarkPatterns = darkPatterns.map((dp) => ({
    kind: dp.kind,
    ...(dp.ref ? { ref: mapRef(dp.ref) } : {}),
    ...(dp.dismissRef ? { dismissRef: mapRef(dp.dismissRef) } : {}),
    ...(dp.label ? { label: redactSensitiveText(dp.label) } : {}),
    text: redactSensitiveText(dp.text).slice(0, 180),
  }));

  const fullText = redactSensitiveText(String(snapshot?.text ?? ""));
  const truncated = fullText.length > maxTextChars;
  const textExcerpt = truncated
    ? `${fullText.slice(0, maxTextChars)}\n[truncated ${fullText.length - maxTextChars} chars]`
    : fullText;

  const urlOriginPath = stripUrlQuery(snapshot?.url ?? "");
  const title = redactSensitiveText(String(snapshot?.title ?? ""));
  const contentHash = fnv1aHash(
    JSON.stringify({
      urlOriginPath,
      title,
      textLen: fullText.length,
      textHead: fullText.slice(0, 1024),
      textTail: fullText.slice(-512),
      controls: controls.map((c) => [
        c.tag,
        c.label,
        c.checked,
        c.selected,
        c.selectedLabel,
        c.hasInput,
        c.disabled,
      ]),
      blockers: blockers.map((b) => [b.kind, b.covers]),
    }),
  );

  return {
    observation: {
      urlOriginPath,
      title,
      lang: snapshot?.lang ?? null,
      pageHeading: sr?.pageHeading ? redactSensitiveText(sr.pageHeading) : null,
      domRevision: snapshot?.domRevision ?? 0,
      contentHash,
      headings,
      landmarks,
      tables,
      cards,
      fileInputs,
      blockers,
      darkPatterns: mappedDarkPatterns,
      controls,
      ...(truncatedControls > 0 ? { truncatedControls } : {}),
      textExcerpt,
      truncated,
    },
    refToElement,
    rawIdToShortRef,
    hasPaymentCredentialField,
  };
}

const VALID_ACTION_KINDS = new Set([
  "click",
  "fill",
  "select",
  "scroll",
  "follow",
  "dismiss_blocker",
  "go_back",
  "request_handoff",
  "ask_user",
  "request_host_port",
  "complete",
  "block",
]);

const VALID_DIRECTIONS = new Set(["up", "down", "left", "right"]);
const VALID_PORTS = new Set([
  "file_upload",
  "observe_download",
  "calendar_reminder",
  "verification_channel",
]);

const normalizeRef = (value) =>
  value.trim().replace(/^\[(e\d+)\]$/i, (_, id) => id.toLowerCase());

/**
 * Strict boundary parser validating planner JSON into a typed `PlannerAction`.
 */
export function parsePlannerAction(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    const trimmed = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end < start)
      return { ok: false, error: "Planner output did not contain a JSON object." };
    try {
      obj = JSON.parse(candidate.slice(start, end + 1));
    } catch (error) {
      return {
        ok: false,
        error: `Invalid planner JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    return { ok: false, error: "Planner action must be a JSON object." };
  const kind = obj.kind ?? obj.action;
  if (typeof kind !== "string" || !VALID_ACTION_KINDS.has(kind))
    return { ok: false, error: `Unsupported planner action kind: ${String(kind)}` };
  const reason =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim()
      : "Planner step";
  const rawNote =
    typeof obj.note === "string"
      ? obj.note
      : typeof obj.remember === "string"
        ? obj.remember
        : "";
  const note = rawNote.trim() ? rawNote.trim().slice(0, 240) : undefined;
  const ok = (action) => ({
    ok: true,
    action: note ? { ...action, note } : action,
  });

  switch (kind) {
    case "click":
    case "follow":
      if (typeof obj.ref !== "string" || !obj.ref.trim())
        return { ok: false, error: `${kind} requires a non-empty ref.` };
      return ok({
        kind,
        ref: normalizeRef(obj.ref),
        reason,
        ...(typeof obj.expectedEffect === "string"
          ? { expectedEffect: obj.expectedEffect.trim() }
          : {}),
      });
    case "fill":
    case "select":
      if (typeof obj.ref !== "string" || !obj.ref.trim())
        return { ok: false, error: `${kind} requires a non-empty ref.` };
      if (typeof obj.text !== "string")
        return { ok: false, error: `${kind} requires a string text.` };
      return ok({ kind, ref: normalizeRef(obj.ref), text: obj.text, reason });
    case "scroll":
      if (typeof obj.direction !== "string" || !VALID_DIRECTIONS.has(obj.direction))
        return {
          ok: false,
          error: "scroll requires direction: up | down | left | right.",
        };
      return ok({
        kind,
        direction: obj.direction,
        ...(typeof obj.ref === "string" && obj.ref.trim()
          ? { ref: normalizeRef(obj.ref) }
          : {}),
        reason,
      });
    case "dismiss_blocker":
      return ok({
        kind,
        ...(Number.isInteger(obj.blockerIndex)
          ? { blockerIndex: obj.blockerIndex }
          : {}),
        reason,
      });
    case "go_back":
      return ok({ kind, reason });
    case "request_handoff":
      if (
        typeof obj.handoffKind !== "string" ||
        !HANDOFF_KINDS.includes(obj.handoffKind)
      )
        return {
          ok: false,
          error: `request_handoff requires valid handoffKind, got ${String(obj.handoffKind)}`,
        };
      return ok({
        kind,
        handoffKind: obj.handoffKind,
        summary:
          typeof obj.summary === "string" && obj.summary.trim()
            ? obj.summary.trim()
            : reason,
        ...(typeof obj.ref === "string" && obj.ref.trim()
          ? { ref: normalizeRef(obj.ref) }
          : {}),
        ...(obj.details && typeof obj.details === "object"
          ? { details: obj.details }
          : {}),
        reason,
      });
    case "ask_user": {
      const question =
        typeof obj.question === "string" ? obj.question.trim() : "";
      const options = Array.isArray(obj.options)
        ? obj.options.filter((o) => typeof o === "string" && o.trim()).slice(0, 6)
        : [];
      if (!question) return { ok: false, error: "ask_user requires a question." };
      return ok({ kind, question, options, reason });
    }
    case "request_host_port":
      if (typeof obj.port !== "string" || !VALID_PORTS.has(obj.port))
        return { ok: false, error: `Unsupported host port: ${String(obj.port)}` };
      return ok({
        kind,
        port: obj.port,
        payload:
          obj.payload && typeof obj.payload === "object" ? obj.payload : {},
        reason,
      });
    case "complete": {
      const summary =
        typeof obj.summary === "string" ? obj.summary.trim() : "";
      const quotes = Array.isArray(obj.quotes)
        ? obj.quotes
            .filter((q) => typeof q === "string" && q.trim())
            .map((q) => q.trim())
        : [];
      if (!summary) return { ok: false, error: "complete requires a summary." };
      return ok({
        kind,
        summary,
        quotes,
        ...(obj.extractedFacts && typeof obj.extractedFacts === "object"
          ? { extractedFacts: obj.extractedFacts }
          : {}),
      });
    }
    case "block":
      return ok({
        kind,
        reason,
        ...(typeof obj.handoffKind === "string" &&
        HANDOFF_KINDS.includes(obj.handoffKind)
          ? { handoffKind: obj.handoffKind }
          : {}),
      });
    default:
      return { ok: false, error: `Unhandled action kind: ${kind}` };
  }
}

const extractSnapshotCorpus = (snapshot) => {
  if (typeof snapshot === "string") return normalizeWhitespace(snapshot).toLowerCase();
  const corpusParts = [
    String(snapshot?.title ?? ""),
    String(snapshot?.text ?? ""),
  ];
  const sr = snapshot?.structuredRegions;
  if (sr) {
    for (const h of sr.headings ?? []) corpusParts.push(String(h.text ?? ""));
    for (const t of sr.tables ?? []) {
      for (const r of t.rows ?? []) corpusParts.push((r.cells ?? []).join(" "));
    }
    for (const c of sr.cards ?? []) {
      if (c.heading) corpusParts.push(String(c.heading));
      corpusParts.push((c.textLines ?? []).join(" "));
    }
  }
  return normalizeWhitespace(corpusParts.join(" ")).toLowerCase();
};

/**
 * Verifies that claimed completion quotes actually appear on the observed page
 * or across any previously observed snapshots in the trajectory
 * (case-insensitive, whitespace-normalized), preventing hallucinated receipts.
 */
export function verifyCompletionQuotes(quotes, snapshotOrCorpus) {
  const list = Array.isArray(quotes)
    ? quotes.filter((q) => typeof q === "string" && q.trim().length > 0)
    : [];
  if (list.length === 0) return { verified: true, matched: [], missing: [] };
  const corpora = Array.isArray(snapshotOrCorpus)
    ? snapshotOrCorpus.map(extractSnapshotCorpus).filter(Boolean)
    : [extractSnapshotCorpus(snapshotOrCorpus)];
  const matched = [];
  const missing = [];
  for (const quote of list) {
    const norm = normalizeWhitespace(quote).toLowerCase();
    if (norm && corpora.some((corpus) => corpus.includes(norm)))
      matched.push(quote);
    else missing.push(quote);
  }
  return { verified: missing.length === 0, matched, missing };
}

/** Serializes telemetry events as zero-PII JSONL (query params & secrets stripped). */
export function formatTelemetryJsonl(events) {
  return (Array.isArray(events) ? events : [])
    .map((event) => {
      const sanitized = {
        ...event,
        urlOriginPath: stripUrlQuery(event.urlOriginPath ?? ""),
        ...(event.targetLabel
          ? { targetLabel: redactSensitiveText(event.targetLabel) }
          : {}),
        ...(event.detail ? { detail: redactSensitiveText(event.detail) } : {}),
      };
      return JSON.stringify(sanitized);
    })
    .join("\n");
}

const DEFAULT_WALKTHROUGH_SYSTEM_PROMPT = `You are a careful, general-purpose web walkthrough planner.
You receive a structured, redacted snapshot of the current web page and a user goal with optional constraints.
Return EXACTLY ONE JSON object describing the next single action to take. Do not output prose outside JSON.

Allowed JSON actions:
- {"kind":"click","ref":"e0","reason":"..."}
- {"kind":"fill","ref":"e1","text":"value","reason":"..."}
- {"kind":"select","ref":"e2","text":"Option label or YYYY-MM-DD","reason":"..."}
- {"kind":"scroll","direction":"down|up|left|right","ref":"e3","reason":"..."} (ref optional)
- {"kind":"follow","ref":"e4","reason":"..."} (navigate an anchor link safely)
- {"kind":"dismiss_blocker","reason":"..."} (dismiss cookie banner or upsell modal safely)
- {"kind":"go_back","reason":"..."}
- {"kind":"request_handoff","handoffKind":"NeedsPrivateSignIn|NeedsMFA|NeedsCaptcha|NeedsFileUpload|NeedsCommitApproval|NeedsUserDisambiguation","summary":"...","ref":"e5","reason":"..."}
- {"kind":"ask_user","question":"...","options":["Option A","Option B"],"reason":"..."}
- {"kind":"request_host_port","port":"file_upload|observe_download|calendar_reminder|verification_channel","payload":{},"reason":"..."}
- {"kind":"complete","summary":"...","quotes":["exact text from page"],"extractedFacts":{}}
- {"kind":"block","reason":"..."}

Strict rules:
1. Reference controls ONLY by their exact short ref from the controls list (e.g. "e0", "e1"). NEVER use CSS selectors, element names, or HTML id attributes as refs.
2. Never fill passwords, payment card numbers, bank account numbers, SSNs, or one-time verification codes directly: emit request_handoff (NeedsPrivateSignIn or NeedsMFA) ONLY when those sensitive fields are still empty (hasInput is false or omitted). Once sensitive fields show hasInput=true or recentHistory shows handoff:NeedsPrivateSignIn/NeedsMFA completed, do NOT emit request_handoff again — proceed directly to submit/continue.
3. Never click or attempt to solve CAPTCHAs: emit request_handoff (NeedsCaptcha).
4. For file uploads (<input type="file"> or upload triggers), emit request_handoff (NeedsFileUpload) or request_host_port (file_upload) unless hasFiles is already true.
5. Avoid dark-pattern traps unless the user goal explicitly asks for them:
   - Skip Sponsored/Promoted/Ad listings and choose organic matching results.
   - Prefer One-Time Purchase over pre-selected Subscribe & Save or recurring plans.
   - Prefer free/standard shipping or zero-fee payment methods over paid defaults.
   - Uncheck pre-checked AutoPay/paperless/warranty/marketing opt-in boxes and decline upsell modals.
6. Controls marked consequence="commit" (final Submit payment, Place order, Confirm appointment, Send message, Cancel service) are safety-gated; click them only when all details are verified on screen and ready for explicit human approval.
7. Only emit "complete" when the goal is truly accomplished, and include verbatim "quotes" copied exactly from text observed on the visited page(s) (such as confirmation numbers, balances, or requested facts).
8. On multi-tab or multi-page tasks, include an optional "note" field on any action to record concise verified facts from the current view before leaving it (e.g. {"kind":"click","ref":"e3","reason":"Open next section","note":"Observed item X and value Y"}). Saved notes are returned in memoryNotes on later turns so you never need to revisit a tab you already inspected.`;

const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

const parseRetryAfterMs = (headerValue) => {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(15_000, Math.max(250, Math.round(seconds * 1000)));
  }
  const timestamp = Date.parse(headerValue);
  if (!Number.isNaN(timestamp)) {
    const delta = timestamp - Date.now();
    if (delta > 0) return Math.min(15_000, Math.max(250, delta));
  }
  return null;
};

/**
 * Provider-agnostic OpenAI-compatible chat-completions planner (works with
 * Cerebras, OpenAI, Cloudflare Workers AI, Ollama, vLLM, etc.).
 * Zero hardcoded models, zero site-specific prompts, zero secret logging.
 */
export function createOpenAICompatiblePlanner({
  baseUrl,
  apiKey,
  model,
  fetch: fetchImpl = globalThis.fetch,
  temperature = 0,
  maxTokens = 2048,
  timeoutMs = 45000,
  maxRetries = 3,
  retryBaseDelayMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  responseFormat = "json_object",
  disableReasoning,
  reasoningEffort,
  extraBody,
  extraHeaders,
  systemPromptSuffix,
}) {
  if (!baseUrl || typeof baseUrl !== "string")
    throw new Error("createOpenAICompatiblePlanner requires baseUrl.");
  if (!model || typeof model !== "string")
    throw new Error("createOpenAICompatiblePlanner requires model.");
  if (typeof fetchImpl !== "function")
    throw new Error("createOpenAICompatiblePlanner requires fetch.");

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const systemContent = systemPromptSuffix
    ? `${DEFAULT_WALKTHROUGH_SYSTEM_PROMPT}\n\n${systemPromptSuffix}`
    : DEFAULT_WALKTHROUGH_SYSTEM_PROMPT;

  return {
    async plan(input) {
      const started = Date.now();
      const userPayload = {
        goal: input.goal,
        step: `${input.stepIndex + 1}/${input.maxSteps}`,
        observation: input.observation,
        ...(input.memoryNotes?.length ? { memoryNotes: input.memoryNotes } : {}),
        ...(input.warnings?.length ? { warnings: input.warnings } : {}),
        ...(input.history?.length ? { recentHistory: input.history.slice(-12) } : {}),
        ...(input.userAnswers?.length ? { userAnswers: input.userAnswers } : {}),
      };
      const body = {
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
        ...(responseFormat === "json_object"
          ? { response_format: { type: "json_object" } }
          : responseFormat && typeof responseFormat === "object"
            ? { response_format: responseFormat }
            : {}),
        ...(disableReasoning === true ? { disable_reasoning: true } : {}),
        ...(typeof reasoningEffort === "string"
          ? { reasoning_effort: reasoningEffort }
          : {}),
        ...(extraBody && typeof extraBody === "object" ? extraBody : {}),
      };
      const headers = {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(extraHeaders && typeof extraHeaders === "object"
          ? extraHeaders
          : {}),
      };
      const retries = Math.max(0, Number.isInteger(maxRetries) ? maxRetries : 3);
      for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!response.ok) {
            if (
              RETRYABLE_HTTP_STATUSES.has(response.status) &&
              attempt < retries
            ) {
              const retryAfter = parseRetryAfterMs(
                response.headers?.get?.("retry-after"),
              );
              const delayMs =
                retryAfter ??
                Math.min(
                  15_000,
                  retryBaseDelayMs * 2 ** attempt +
                    Math.floor(Math.random() * Math.min(250, retryBaseDelayMs)),
                );
              clearTimeout(timer);
              await sleep(delayMs);
              continue;
            }
            return {
              action: null,
              parseError: `Planner HTTP ${response.status}`,
              latencyMs: Date.now() - started,
              tokenUsage: null,
            };
          }
          const data = await response.json();
          const latencyMs = Date.now() - started;
          const choice = data?.choices?.[0];
          const rawText = choice?.message?.content ?? "";
          const usage = data?.usage
            ? {
                promptTokens: data.usage.prompt_tokens ?? 0,
                completionTokens: data.usage.completion_tokens ?? 0,
                totalTokens: data.usage.total_tokens ?? 0,
              }
            : null;
          if (!String(rawText).trim() && choice?.finish_reason === "length") {
            return {
              action: null,
              parseError:
                "Planner output truncated (finish_reason=length); increase maxTokens or disable reasoning.",
              latencyMs,
              tokenUsage: usage,
            };
          }
          const parsed = parsePlannerAction(rawText);
          if (!parsed.ok) {
            return {
              action: null,
              parseError: parsed.error,
              latencyMs,
              tokenUsage: usage,
            };
          }
          return {
            action: parsed.action,
            latencyMs,
            tokenUsage: usage,
          };
        } catch (error) {
          if (attempt < retries) {
            const delayMs = Math.min(15_000, retryBaseDelayMs * 2 ** attempt);
            clearTimeout(timer);
            await sleep(delayMs);
            continue;
          }
          return {
            action: null,
            parseError:
              error instanceof Error ? error.message : String(error),
            latencyMs: Date.now() - started,
            tokenUsage: null,
          };
        } finally {
          clearTimeout(timer);
        }
      }
      return {
        action: null,
        parseError: "Planner failed after retries.",
        latencyMs: Date.now() - started,
        tokenUsage: null,
      };
    },
  };
}

const makeRunId = () =>
  typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `wt-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

const goalMentions = (goal, pattern) => {
  const combined = [goal?.instruction ?? "", ...(goal?.constraints ?? [])].join(" ");
  return pattern.test(combined);
};

/**
 * Reusable site-agnostic Observe -> Plan -> Gate -> Act/Guide -> Verify -> HITL-Commit
 * walkthrough engine. Supports both step-by-step (`step()` + `resume()`) and
 * continuous (`run()`) execution.
 */
export function createWalkthroughEngine({
  goal,
  transport,
  planner,
  ports = {},
  options = {},
}) {
  if (!goal || typeof goal.instruction !== "string" || !goal.instruction.trim())
    throw new Error("createWalkthroughEngine requires goal.instruction.");
  if (!transport || typeof transport.snapshot !== "function" || typeof transport.execute !== "function")
    throw new Error("createWalkthroughEngine requires transport.snapshot and transport.execute.");
  if (!planner || typeof planner.plan !== "function")
    throw new Error("createWalkthroughEngine requires planner.plan.");

  const runId = goal.id || makeRunId();
  const maxSteps = goal.maxSteps ?? 25;
  const maxStagnantSteps = goal.maxStagnantSteps ?? 3;
  const maxRepeatedActionAttempts = goal.maxRepeatedActionAttempts ?? 2;
  const autoDismissBlockers = goal.autoDismissBlockers !== false;
  const requireApprovalForCommit = goal.requireApprovalForCommit !== false;
  const allowSameSiteSubdomains = goal.allowSameSiteSubdomains === true;
  const allowedOrigins = new Set(goal.allowedOrigins ?? []);

  let phase = "idle";
  let stepIndex = 0;
  let stagnantSteps = 0;
  let unverifiedCompletionRetries = 0;
  let pendingHandoff = null;
  let pendingActionContext = null;
  let lastSnapshot = null;
  let lastSanitized = null;
  const history = [];
  const warnings = [];
  const userAnswers = [];
  const memoryNotes = [];
  const observedCorpus = [];
  const seenCorpusHashes = new Set();
  const actionAttempts = new Map();
  const telemetry = [];
  const resolvedHandoffKeys = new Set();

  const recordMemoryNote = (rawNote, heading = null) => {
    if (typeof rawNote !== "string" || !rawNote.trim()) return;
    const clean = redactSensitiveText(normalizeWhitespace(rawNote)).slice(0, 240);
    if (!clean) return;
    const entry =
      heading && !clean.toLowerCase().includes(String(heading).toLowerCase())
        ? `[${redactSensitiveText(String(heading)).slice(0, 60)}] ${clean}`
        : clean;
    if (!memoryNotes.includes(entry)) {
      memoryNotes.push(entry);
      if (memoryNotes.length > 24) memoryNotes.shift();
    }
  };

  const emitTelemetry = async (event) => {
    const clean = {
      timestamp: new Date().toISOString(),
      runId,
      stepIndex,
      phase,
      urlOriginPath: stripUrlQuery(event.urlOriginPath ?? lastSnapshot?.url ?? ""),
      domRevision: event.domRevision ?? lastSnapshot?.domRevision ?? 0,
      candidateCount: event.candidateCount ?? lastSanitized?.observation?.controls?.length ?? 0,
      blockerKinds: event.blockerKinds ?? (lastSanitized?.observation?.blockers ?? []).map((b) => b.kind),
      darkPatternFlags:
        event.darkPatternFlags ??
        (lastSanitized?.observation?.darkPatterns ?? []).map((d) => d.kind),
      plannerActionKind: event.plannerActionKind ?? null,
      targetLabel: event.targetLabel ? redactSensitiveText(event.targetLabel) : null,
      consequenceClass: event.consequenceClass ?? null,
      gateVerdict: event.gateVerdict ?? "observed",
      handoffKind: event.handoffKind ?? null,
      readbackVerified: event.readbackVerified ?? null,
      domChanged: event.domChanged ?? null,
      urlChanged: event.urlChanged ?? null,
      latencyMs: event.latencyMs ?? 0,
      tokenUsage: event.tokenUsage ?? null,
      ...(event.detail ? { detail: redactSensitiveText(event.detail) } : {}),
    };
    telemetry.push(clean);
    if (typeof ports.onTelemetry === "function") await ports.onTelemetry(clean);
    return clean;
  };

  const pauseForHandoff = async (handoff, actionCtx, telemetryMeta = {}) => {
    phase = "paused_handoff";
    pendingHandoff = handoff;
    pendingActionContext = actionCtx ?? null;
    const telemetryEvent = await emitTelemetry({
      ...telemetryMeta,
      gateVerdict: "gated_handoff",
      handoffKind: handoff.kind,
      detail: handoff.summary,
    });
    return {
      status: "paused",
      phase,
      stepIndex,
      handoff,
      telemetryEvent,
      state: getState(),
    };
  };

  const resolveElement = (sanitized, ref) => {
    if (!ref) return null;
    if (sanitized.refToElement.has(ref)) return sanitized.refToElement.get(ref);
    // Defensive fallback if a model emitted raw snapshot element id or targetSelector
    const elements = Array.isArray(lastSnapshot?.elements)
      ? lastSnapshot.elements
      : [];
    const byId = elements.filter((el) => el.id === ref || el.selector === ref);
    if (byId.length === 1) return byId[0];
    const byTarget = elements.filter((el) => el.targetSelector === ref);
    if (byTarget.length === 1) return byTarget[0];
    return null;
  };

  const observePage = async () => {
    phase = "observing";
    const snapshot = await transport.snapshot({ structuredRegions: true });
    lastSnapshot = snapshot;
    lastSanitized = sanitizeObservationForPlanner(snapshot, options.sanitize);
    const hash = lastSanitized.observation.contentHash;
    if (!seenCorpusHashes.has(hash)) {
      seenCorpusHashes.add(hash);
      const corpus = extractSnapshotCorpus(snapshot);
      if (corpus) {
        observedCorpus.push(corpus);
        if (observedCorpus.length > 40) observedCorpus.shift();
      }
    }
    if (snapshot?.url) {
      try {
        const origin = new URL(snapshot.url).origin;
        if (allowedOrigins.size === 0) allowedOrigins.add(origin);
      } catch {}
    }
    return { snapshot, sanitized: lastSanitized };
  };

  const buildCommandForElement = (snapshot, element, action, extra = {}) => {
    const nodeId =
      typeof element.id === "string"
        ? element.id
        : typeof element.selector === "string"
          ? element.selector.split(":").at(-1)
          : undefined;
    const selector =
      typeof element.selector === "string"
        ? element.selector
        : snapshot?.snapshotId && nodeId !== undefined
          ? `${snapshot.snapshotId}:0:${nodeId}`
          : undefined;
    return {
      subaction: action,
      ...(snapshot?.snapshotId ? { snapshotId: snapshot.snapshotId } : {}),
      ...(nodeId !== undefined ? { nodeId } : {}),
      ...(selector ? { selector } : {}),
      ...(element.targetSelector
        ? { expectedSelector: element.targetSelector }
        : {}),
      ...extra,
    };
  };

  const executeAndVerify = async ({
    beforeSnapshot,
    beforeSanitized,
    command,
    targetElement,
    actionKind,
    consequenceClass,
    plannerLatencyMs = 0,
    tokenUsage = null,
    commitGrant = undefined,
    gateVerdict = "allowed",
    attemptKey = undefined,
    note = undefined,
  }) => {
    phase = "acting";
    const execStart = Date.now();
    const finalCommand = commitGrant ? { ...command, commitGrant } : command;
    let execResult;
    try {
      execResult = await transport.execute(finalCommand);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      warnings.push(`Action failed: ${msg}`);
      history.push({
        stepIndex,
        action: actionKind,
        target: redactSensitiveText(targetElement?.label || targetElement?.inferredLabel || ""),
        outcome: "error",
        error: redactSensitiveText(msg),
      });
      const telemetryEvent = await emitTelemetry({
        plannerActionKind: actionKind,
        targetLabel: targetElement?.label || targetElement?.inferredLabel || null,
        consequenceClass,
        gateVerdict: "blocked_policy",
        latencyMs: plannerLatencyMs + (Date.now() - execStart),
        tokenUsage,
        detail: msg,
      });
      stepIndex++;
      return { status: "continue", phase: "verifying", stepIndex, telemetryEvent, state: getState() };
    }

    if (execResult?.error) {
      const kind = execResult.error.kind ?? "ERROR";
      const reason = execResult.error.reason ?? execResult.error.message ?? kind;
      if (reason === "file-upload-requires-host-picker") {
        return pauseForHandoff(
          {
            kind: "NeedsFileUpload",
            summary: `Choose a file for "${targetElement?.label || "file upload"}".`,
            targetSelector: targetElement?.targetSelector ?? null,
            accept: execResult.error.accept ?? targetElement?.fileInput?.accept ?? null,
            multiple: execResult.error.multiple === true,
          },
          { command, targetElement, actionKind },
          {
            plannerActionKind: actionKind,
            targetLabel: targetElement?.label ?? null,
            consequenceClass: "person_only",
            latencyMs: plannerLatencyMs + (Date.now() - execStart),
            tokenUsage,
          },
        );
      }
      if (kind === "STALE_REF") {
        if (attemptKey) {
          const prev = actionAttempts.get(attemptKey) ?? 0;
          if (prev > 0) actionAttempts.set(attemptKey, prev - 1);
        }
        warnings.push(
          `The page updated while executing ${actionKind} on "${redactSensitiveText(targetElement?.label || "")}" (STALE_REF). A fresh snapshot has been observed; choose the updated ref if still needed.`,
        );
        history.push({
          stepIndex,
          action: actionKind,
          target: redactSensitiveText(targetElement?.label || ""),
          outcome: "stale_ref",
        });
        const telemetryEvent = await emitTelemetry({
          plannerActionKind: actionKind,
          targetLabel: targetElement?.label ?? null,
          consequenceClass,
          gateVerdict: "stale_ref",
          latencyMs: plannerLatencyMs + (Date.now() - execStart),
          tokenUsage,
          detail: `${kind}: ${reason}`,
        });
        stepIndex++;
        return { status: "continue", phase: "verifying", stepIndex, telemetryEvent, state: getState() };
      }
      warnings.push(`Browser refused ${actionKind} (${kind}): ${reason}`);
      history.push({
        stepIndex,
        action: actionKind,
        target: redactSensitiveText(targetElement?.label || ""),
        outcome: `refused:${kind}`,
      });
      const telemetryEvent = await emitTelemetry({
        plannerActionKind: actionKind,
        targetLabel: targetElement?.label ?? null,
        consequenceClass,
        gateVerdict: "blocked_policy",
        latencyMs: plannerLatencyMs + (Date.now() - execStart),
        tokenUsage,
        detail: `${kind}: ${reason}`,
      });
      stepIndex++;
      return { status: "continue", phase: "verifying", stepIndex, telemetryEvent, state: getState() };
    }

    // Post-action verification: fresh snapshot + readback checks
    phase = "verifying";
    const { snapshot: afterSnapshot, sanitized: afterSanitized } = await observePage();
    const urlChanged = afterSnapshot.url !== beforeSnapshot.url;
    const domChanged =
      afterSnapshot.domRevision !== beforeSnapshot.domRevision ||
      afterSanitized.observation.contentHash !== beforeSanitized.observation.contentHash;
    let readbackVerified = true;
    if (actionKind === "fill") {
      if (afterSnapshot.inputReadback) {
        readbackVerified = afterSnapshot.inputReadback.matches === true;
      } else if (targetElement?.targetSelector) {
        const afterEl = (afterSnapshot.elements ?? []).find(
          (el) => el.targetSelector === targetElement.targetSelector,
        );
        readbackVerified = afterEl ? afterEl.hasInput === true || command.text === "" : domChanged;
      }
    } else if (actionKind === "select") {
      if (targetElement?.targetSelector) {
        const afterEl = (afterSnapshot.elements ?? []).find(
          (el) => el.targetSelector === targetElement.targetSelector,
        );
        readbackVerified = afterEl
          ? domChanged ||
            (afterEl.selectedLabel &&
              afterEl.selectedLabel.toLowerCase() ===
                String(command.text ?? "").trim().toLowerCase()) ||
            afterEl.checked === true ||
            afterEl.hasInput === true
          : domChanged;
      }
    }

    if (afterSnapshot.effectViolation) {
      phase = "blocked";
      const telemetryEvent = await emitTelemetry({
        plannerActionKind: actionKind,
        targetLabel: targetElement?.label ?? null,
        consequenceClass,
        gateVerdict: "blocked_policy",
        readbackVerified: false,
        domChanged,
        urlChanged,
        latencyMs: plannerLatencyMs + (Date.now() - execStart),
        tokenUsage,
        detail: `effectViolation:${afterSnapshot.effectViolation}`,
      });
      return {
        status: "blocked",
        phase,
        stepIndex,
        reason: `Unexpected page side-effect (${afterSnapshot.effectViolation}); observe before continuing.`,
        telemetryEvent,
        state: getState(),
      };
    }

    const confirmedSameValue =
      (actionKind === "fill" || actionKind === "select") &&
      readbackVerified === true;
    const downloaded = execResult?.downloaded === true;
    if (
      !urlChanged &&
      !domChanged &&
      actionKind !== "scroll" &&
      !confirmedSameValue &&
      !downloaded
    ) {
      stagnantSteps++;
      warnings.push(
        `Previous ${actionKind} on "${redactSensitiveText(targetElement?.label || "")}" produced no observable page change.`,
      );
    } else {
      stagnantSteps = 0;
    }

    history.push({
      stepIndex,
      action: actionKind,
      target: redactSensitiveText(
        targetElement?.label || targetElement?.inferredLabel || "",
      ),
      ...((actionKind === "fill" || actionKind === "select") &&
      !targetElement?.sensitive &&
      typeof command.text === "string"
        ? { value: redactSensitiveText(command.text).slice(0, 100) }
        : {}),
      ...(downloaded ? { downloaded: true } : {}),
      ...(beforeSanitized?.observation?.pageHeading
        ? { fromHeading: beforeSanitized.observation.pageHeading }
        : {}),
      ...(note ? { note: redactSensitiveText(note) } : {}),
      outcome: downloaded ? "downloaded" : "dispatched",
      urlChanged,
      domChanged,
      readbackVerified,
    });

    const telemetryEvent = await emitTelemetry({
      urlOriginPath: afterSnapshot.url,
      domRevision: afterSnapshot.domRevision,
      plannerActionKind: actionKind,
      targetLabel: targetElement?.label || targetElement?.inferredLabel || null,
      consequenceClass,
      gateVerdict,
      readbackVerified,
      domChanged,
      urlChanged,
      latencyMs: plannerLatencyMs + (Date.now() - execStart),
      tokenUsage,
    });
    stepIndex++;

    if (stagnantSteps >= maxStagnantSteps) {
      phase = "blocked";
      return {
        status: "blocked",
        phase,
        stepIndex,
        reason: `Walkthrough stalled after ${stagnantSteps} consecutive actions with no page change.`,
        telemetryEvent,
        state: getState(),
      };
    }

    return {
      status: "continue",
      phase,
      stepIndex,
      telemetryEvent,
      state: getState(),
    };
  };

  async function resume(resolution = {}) {
    if (phase !== "paused_handoff" || !pendingHandoff) {
      throw new Error("Cannot resume walkthrough when not paused on a handoff.");
    }
    const handoff = pendingHandoff;
    const actionCtx = pendingActionContext;
    pendingHandoff = null;
    pendingActionContext = null;

    if (resolution.kind === "cancelled" || resolution.kind === "rejected") {
      const reason = resolution.reason || `Handoff ${handoff.kind} was ${resolution.kind}.`;
      if (handoff.kind === "NeedsCommitApproval") {
        warnings.push(`User declined commit action: ${reason}`);
        userAnswers.push({ question: handoff.summary, answer: `Declined (${reason})` });
        phase = "observing";
        return { status: "continue", phase, stepIndex, state: getState() };
      }
      phase = "blocked";
      const telemetryEvent = await emitTelemetry({
        gateVerdict: "blocked_policy",
        handoffKind: handoff.kind,
        detail: reason,
      });
      return { status: "blocked", phase, stepIndex, reason, telemetryEvent, state: getState() };
    }

    if (handoff.kind === "NeedsUntrustedOriginApproval") {
      if (resolution.allowOrigin) allowedOrigins.add(resolution.allowOrigin);
      history.push({
        stepIndex,
        action: "handoff:NeedsUntrustedOriginApproval",
        target: redactSensitiveText(handoff.targetOrigin || handoff.summary || ""),
        outcome: "approved",
      });
      stepIndex++;
      phase = "observing";
      return { status: "continue", phase, stepIndex, state: getState() };
    }
    if (handoff.kind === "NeedsUserDisambiguation") {
      const answerText = resolution.answer
        ? redactSensitiveText(String(resolution.answer))
        : "Proceed with goal";
      userAnswers.push({
        question: handoff.summary,
        answer: answerText,
      });
      resolvedHandoffKeys.add(
        `disambig:${normalizeWhitespace(handoff.summary).toLowerCase()}`,
      );
      history.push({
        stepIndex,
        action: "handoff:NeedsUserDisambiguation",
        target: redactSensitiveText(handoff.summary).slice(0, 120),
        outcome: "answered",
      });
      stepIndex++;
      phase = "observing";
      return { status: "continue", phase, stepIndex, state: getState() };
    }
    if (
      handoff.kind === "NeedsPrivateSignIn" ||
      handoff.kind === "NeedsMFA" ||
      handoff.kind === "NeedsCaptcha" ||
      handoff.kind === "NeedsFileUpload"
    ) {
      const beforeUrlPath = stripUrlQuery(lastSnapshot?.url ?? "");
      resolvedHandoffKeys.add(`${handoff.kind}:${beforeUrlPath}`);
      if (handoff.targetSelector) {
        resolvedHandoffKeys.add(
          `${handoff.kind}:${beforeUrlPath}:${handoff.targetSelector}`,
        );
      }
      stagnantSteps = 0;
      phase = "observing";
      const { snapshot: afterSnap, sanitized: afterSan } = await observePage();
      const afterUrlPath = stripUrlQuery(afterSnap?.url ?? "");
      resolvedHandoffKeys.add(
        `${handoff.kind}:${afterUrlPath}:${afterSan.observation.contentHash}`,
      );
      history.push({
        stepIndex,
        action: `handoff:${handoff.kind}`,
        target: redactSensitiveText(
          handoff.targetLabel || handoff.summary || "",
        ).slice(0, 120),
        outcome: "human_completed",
      });
      stepIndex++;
      return { status: "continue", phase, stepIndex, state: getState() };
    }
    if (handoff.kind === "NeedsCommitApproval") {
      if (resolution.humanCompleted === true) {
        stagnantSteps = 0;
        phase = "observing";
        await observePage();
        history.push({
          stepIndex,
          action: actionCtx?.actionKind ?? "commit",
          target: redactSensitiveText(actionCtx?.targetElement?.label ?? ""),
          outcome: "human_completed",
        });
        stepIndex++;
        return { status: "continue", phase, stepIndex, state: getState() };
      }
      if (actionCtx && (resolution.commitGrant || resolution.approved === true)) {
        // Re-observe to ensure target is still valid before executing approved commit
        const beforeSnapshot = lastSnapshot;
        const beforeSanitized = lastSanitized;
        return executeAndVerify({
          beforeSnapshot,
          beforeSanitized,
          command: actionCtx.command,
          targetElement: actionCtx.targetElement,
          actionKind: actionCtx.actionKind,
          consequenceClass: "commit",
          commitGrant: resolution.commitGrant,
          gateVerdict: "allowed",
        });
      }
      phase = "blocked";
      return {
        status: "blocked",
        phase,
        stepIndex,
        reason: "Commit approval resumed without commitGrant or humanCompleted.",
        state: getState(),
      };
    }

    phase = "observing";
    return { status: "continue", phase, stepIndex, state: getState() };
  }

  async function step() {
    if (phase === "paused_handoff") {
      return {
        status: "paused",
        phase,
        stepIndex,
        handoff: pendingHandoff,
        state: getState(),
      };
    }
    if (phase === "completed" || phase === "blocked" || phase === "failed") {
      return { status: phase, phase, stepIndex, state: getState() };
    }
    if (stepIndex >= maxSteps) {
      phase = "blocked";
      const telemetryEvent = await emitTelemetry({
        gateVerdict: "blocked_loop",
        detail: `Reached maxSteps (${maxSteps})`,
      });
      return {
        status: "blocked",
        phase,
        stepIndex,
        reason: `Reached maximum walkthrough step budget (${maxSteps}).`,
        telemetryEvent,
        state: getState(),
      };
    }

    const { snapshot, sanitized } = await observePage();
    const currentUrl = snapshot?.url ?? "";

    // 1. Origin safety port check
    if (typeof ports.checkOriginSafety === "function" && currentUrl) {
      const safety = await ports.checkOriginSafety(currentUrl);
      if (safety && safety.safe === false) {
        phase = "blocked";
        const telemetryEvent = await emitTelemetry({
          gateVerdict: "blocked_policy",
          detail: safety.reason || "Origin refused by host safety check",
        });
        return {
          status: "blocked",
          phase,
          stepIndex,
          reason: safety.reason || "Unsafe or lookalike origin blocked.",
          telemetryEvent,
          state: getState(),
        };
      }
    }

    // 2. Deterministic CAPTCHA / blocking login-wall pre-check
    const blockers = Array.isArray(snapshot?.blockers) ? snapshot.blockers : [];
    const captchaBlocker = blockers.find((b) => b.kind === "captcha");
    if (captchaBlocker) {
      return pauseForHandoff(
        {
          kind: "NeedsCaptcha",
          summary:
            "A human verification challenge (CAPTCHA) is blocking this page. Please complete it to continue.",
          text: redactSensitiveText(captchaBlocker.text ?? ""),
        },
        null,
        { consequenceClass: "person_only" },
      );
    }

    const loginBlocker = blockers.find(
      (b) => b.kind === "login-wall" && b.covers !== "partial",
    );
    const loginKey = `NeedsPrivateSignIn:${stripUrlQuery(currentUrl)}`;
    if (loginBlocker && !resolvedHandoffKeys.has(loginKey)) {
      return pauseForHandoff(
        {
          kind: "NeedsPrivateSignIn",
          summary:
            "This page requires you to sign in privately before the walkthrough can continue.",
          urlOriginPath: stripUrlQuery(currentUrl),
          text: redactSensitiveText(loginBlocker.text ?? ""),
        },
        null,
        { consequenceClass: "person_only" },
      );
    }

    // 3. Safe automatic blocker dismissal (cookie rejectRef or non-agreeing modal ref)
    if (autoDismissBlockers) {
      const dismissPlan = dismissBlockerCommand(snapshot, { preferReject: true });
      if (
        dismissPlan &&
        (dismissPlan.blocker.covers === "viewport" ||
          dismissPlan.blocker.covers === "target" ||
          dismissPlan.blocker.kind === "cookie-consent")
      ) {
        const attemptKey = `dismiss:${stripUrlQuery(currentUrl)}:${dismissPlan.element.targetSelector ?? dismissPlan.element.id}`;
        const tries = actionAttempts.get(attemptKey) ?? 0;
        if (tries < 1) {
          actionAttempts.set(attemptKey, tries + 1);
          return executeAndVerify({
            beforeSnapshot: snapshot,
            beforeSanitized: sanitized,
            command: dismissPlan.command,
            targetElement: dismissPlan.element,
            actionKind: "dismiss_blocker",
            consequenceClass: "observe",
            gateVerdict: "auto_dismissed",
          });
        }
      }
    }

    // 4. Plan next step with redacted semantic observation
    phase = "planning";
    const stepWarnings = [...warnings.splice(0)];
    for (const dp of sanitized.observation.darkPatterns) {
      stepWarnings.push(
        `Dark pattern (${dp.kind}): ${dp.label ? `"${dp.label}" — ` : ""}${dp.text}`,
      );
    }
    const planResult = await planner.plan({
      goal: {
        instruction: goal.instruction,
        constraints: goal.constraints ?? [],
      },
      stepIndex,
      maxSteps,
      observation: sanitized.observation,
      memoryNotes,
      history,
      warnings: stepWarnings,
      userAnswers,
    });

    if (!planResult?.action) {
      const err = planResult?.parseError || "Planner returned no valid action.";
      warnings.push(err);
      const telemetryEvent = await emitTelemetry({
        gateVerdict: "blocked_policy",
        latencyMs: planResult?.latencyMs ?? 0,
        tokenUsage: planResult?.tokenUsage ?? null,
        detail: err,
      });
      stepIndex++;
      stagnantSteps++;
      if (stagnantSteps >= maxStagnantSteps) {
        phase = "failed";
        return {
          status: "failed",
          phase,
          stepIndex,
          reason: err,
          telemetryEvent,
          state: getState(),
        };
      }
      return { status: "continue", phase, stepIndex, telemetryEvent, state: getState() };
    }

    const action = planResult.action;
    const plannerLatencyMs = planResult.latencyMs ?? 0;
    const tokenUsage = planResult.tokenUsage ?? null;
    if (typeof action.note === "string" && action.note.trim()) {
      recordMemoryNote(action.note, sanitized.observation.pageHeading);
    }

    // 5. Handle non-DOM planner actions
    if (action.kind === "complete") {
      const quoteCheck = verifyCompletionQuotes(
        action.quotes,
        observedCorpus.length > 0 ? observedCorpus : snapshot,
      );
      if (!quoteCheck.verified && unverifiedCompletionRetries < 1) {
        unverifiedCompletionRetries++;
        warnings.push(
          `Completion rejected: claimed quotes were not found verbatim on any visited page (${quoteCheck.missing.join("; ")}). Quote only text actually observed during the walkthrough.`,
        );
        const telemetryEvent = await emitTelemetry({
          plannerActionKind: "complete",
          gateVerdict: "blocked_policy",
          readbackVerified: false,
          latencyMs: plannerLatencyMs,
          tokenUsage,
          detail: `unverified-quotes:${quoteCheck.missing.length}`,
        });
        stepIndex++;
        return { status: "continue", phase: "verifying", stepIndex, telemetryEvent, state: getState() };
      }
      phase = "completed";
      const telemetryEvent = await emitTelemetry({
        plannerActionKind: "complete",
        consequenceClass: "observe",
        gateVerdict: "allowed",
        readbackVerified: quoteCheck.verified,
        latencyMs: plannerLatencyMs,
        tokenUsage,
        detail: action.summary,
      });
      return {
        status: "completed",
        phase,
        stepIndex,
        summary: redactSensitiveText(action.summary),
        quotes: action.quotes,
        extractedFacts: action.extractedFacts ?? null,
        quotesVerified: quoteCheck.verified,
        telemetryEvent,
        state: getState(),
      };
    }

    if (action.kind === "block") {
      phase = "blocked";
      const telemetryEvent = await emitTelemetry({
        plannerActionKind: "block",
        gateVerdict: "blocked_policy",
        handoffKind: action.handoffKind ?? null,
        latencyMs: plannerLatencyMs,
        tokenUsage,
        detail: action.reason,
      });
      return {
        status: "blocked",
        phase,
        stepIndex,
        reason: action.reason,
        telemetryEvent,
        state: getState(),
      };
    }

    if (action.kind === "request_handoff") {
      const targetElement = action.ref
        ? resolveElement(sanitized, action.ref)
        : null;
      const urlPath = stripUrlQuery(currentUrl);
      const stateHandoffKey = `${action.handoffKind}:${urlPath}:${sanitized.observation.contentHash}`;
      const targetHandoffKey = targetElement?.targetSelector
        ? `${action.handoffKind}:${urlPath}:${targetElement.targetSelector}`
        : null;
      const pageElements = Array.isArray(snapshot?.elements)
        ? snapshot.elements
        : [];
      const editableSensitive = pageElements.filter(
        (el) =>
          !el.scrollOnly &&
          !el.disabled &&
          !el.readOnly &&
          (action.handoffKind === "NeedsMFA"
            ? el.sensitive === "one-time-code"
            : ["password", "payment-card", "bank-account", "government-id"].includes(
                el.sensitive,
              )),
      );
      const allSensitiveFilled =
        (action.handoffKind === "NeedsPrivateSignIn" ||
          action.handoffKind === "NeedsMFA") &&
        editableSensitive.length > 0 &&
        editableSensitive.every((el) => el.hasInput === true);
      const targetAlreadySatisfied =
        ((action.handoffKind === "NeedsPrivateSignIn" ||
          action.handoffKind === "NeedsMFA") &&
          targetElement?.hasInput === true) ||
        (action.handoffKind === "NeedsFileUpload" &&
          targetElement?.fileInput?.hasFiles === true);
      const allFilesUploaded =
        action.handoffKind === "NeedsFileUpload" &&
        sanitized.observation.fileInputs.length > 0 &&
        sanitized.observation.fileInputs.every((fi) => fi.hasFiles === true);
      const alreadyCompletedOnState =
        resolvedHandoffKeys.has(stateHandoffKey) ||
        (targetHandoffKey !== null &&
          resolvedHandoffKeys.has(targetHandoffKey) &&
          targetAlreadySatisfied);
      if (
        allSensitiveFilled ||
        targetAlreadySatisfied ||
        allFilesUploaded ||
        alreadyCompletedOnState
      ) {
        warnings.push(
          `The user already completed ${action.handoffKind} and the sensitive/upload fields on this page are already filled (hasInput=true). Do NOT call request_handoff again — proceed directly to submit, continue, or the next step.`,
        );
        const telemetryEvent = await emitTelemetry({
          plannerActionKind: action.kind,
          targetLabel: targetElement?.label ?? null,
          consequenceClass: "observe",
          gateVerdict: "blocked_loop",
          handoffKind: action.handoffKind,
          latencyMs: plannerLatencyMs,
          tokenUsage,
          detail: `handoff-already-completed:${action.handoffKind}`,
        });
        stepIndex++;
        stagnantSteps++;
        if (stagnantSteps >= maxStagnantSteps) {
          phase = "blocked";
          return {
            status: "blocked",
            phase,
            stepIndex,
            reason: `Loop fence triggered after repeated ${action.handoffKind} requests on already-completed fields.`,
            telemetryEvent,
            state: getState(),
          };
        }
        return {
          status: "continue",
          phase: "verifying",
          stepIndex,
          telemetryEvent,
          state: getState(),
        };
      }
      return pauseForHandoff(
        {
          kind: action.handoffKind,
          summary: redactSensitiveText(action.summary),
          ...(targetElement?.label
            ? { targetLabel: redactSensitiveText(targetElement.label) }
            : {}),
          ...(targetElement?.targetSelector
            ? { targetSelector: targetElement.targetSelector }
            : {}),
          ...(action.details ? { details: action.details } : {}),
        },
        null,
        {
          plannerActionKind: action.kind,
          targetLabel: targetElement?.label ?? null,
          consequenceClass: "person_only",
          latencyMs: plannerLatencyMs,
          tokenUsage,
        },
      );
    }

    if (action.kind === "ask_user") {
      const qKey = `disambig:${normalizeWhitespace(action.question).toLowerCase()}`;
      if (resolvedHandoffKeys.has(qKey) || userAnswers.length >= 3) {
        warnings.push(
          "The user already answered your question (see userAnswers). Do NOT call ask_user again — act directly on the user's answer or goal.",
        );
        const telemetryEvent = await emitTelemetry({
          plannerActionKind: action.kind,
          consequenceClass: "observe",
          gateVerdict: "blocked_loop",
          handoffKind: "NeedsUserDisambiguation",
          latencyMs: plannerLatencyMs,
          tokenUsage,
          detail: "repeated-ask-user",
        });
        stepIndex++;
        stagnantSteps++;
        if (stagnantSteps >= maxStagnantSteps) {
          phase = "blocked";
          return {
            status: "blocked",
            phase,
            stepIndex,
            reason: "Loop fence triggered after repeated ask_user prompts.",
            telemetryEvent,
            state: getState(),
          };
        }
        return {
          status: "continue",
          phase: "verifying",
          stepIndex,
          telemetryEvent,
          state: getState(),
        };
      }
      return pauseForHandoff(
        {
          kind: "NeedsUserDisambiguation",
          summary: redactSensitiveText(action.question),
          options: action.options,
        },
        null,
        {
          plannerActionKind: action.kind,
          consequenceClass: "observe",
          latencyMs: plannerLatencyMs,
          tokenUsage,
        },
      );
    }

    if (action.kind === "request_host_port") {
      const portMap = {
        file_upload: ports.requestFileUpload,
        observe_download: ports.observeDownload,
        calendar_reminder: ports.proposeCalendarReminder,
        verification_channel: ports.lookupVerificationChannel,
      };
      const fn = portMap[action.port];
      if (typeof fn !== "function") {
        if (action.port === "file_upload") {
          return pauseForHandoff(
            {
              kind: "NeedsFileUpload",
              summary: redactSensitiveText(action.reason),
              details: action.payload,
            },
            null,
            {
              plannerActionKind: action.kind,
              consequenceClass: "person_only",
              latencyMs: plannerLatencyMs,
              tokenUsage,
            },
          );
        }
        warnings.push(`Host capability port "${action.port}" is unavailable.`);
        stepIndex++;
        return { status: "continue", phase: "verifying", stepIndex, state: getState() };
      }
      const portResult = await fn(action.payload);
      history.push({
        stepIndex,
        action: `port:${action.port}`,
        outcome: portResult?.ok === false ? "declined" : "completed",
      });
      const telemetryEvent = await emitTelemetry({
        plannerActionKind: action.kind,
        consequenceClass: "stage",
        gateVerdict: "allowed",
        latencyMs: plannerLatencyMs,
        tokenUsage,
        detail: `port:${action.port}`,
      });
      stepIndex++;
      return { status: "continue", phase: "verifying", stepIndex, telemetryEvent, state: getState() };
    }

    if (action.kind === "go_back") {
      if (typeof transport.goBack !== "function") {
        warnings.push("Browser transport does not support go_back.");
        stepIndex++;
        return { status: "continue", phase: "verifying", stepIndex, state: getState() };
      }
      await transport.goBack();
      const { snapshot: after } = await observePage();
      const telemetryEvent = await emitTelemetry({
        urlOriginPath: after.url,
        plannerActionKind: "go_back",
        consequenceClass: "navigate",
        gateVerdict: "allowed",
        urlChanged: after.url !== snapshot.url,
        domChanged: true,
        latencyMs: plannerLatencyMs,
        tokenUsage,
      });
      stepIndex++;
      return { status: "continue", phase: "verifying", stepIndex, telemetryEvent, state: getState() };
    }

    if (action.kind === "dismiss_blocker") {
      const plan = dismissBlockerCommand(snapshot, { preferReject: true });
      if (!plan) {
        stagnantSteps++;
        warnings.push(
          "No automatic reject/close control exists for this blocker. Do NOT call dismiss_blocker again — either click a visible banner button directly (e.g. Manage preferences or Accept) or proceed directly with the page controls.",
        );
        history.push({
          stepIndex,
          action: "dismiss_blocker",
          outcome: "no_auto_dismiss",
        });
        const telemetryEvent = await emitTelemetry({
          plannerActionKind: "dismiss_blocker",
          consequenceClass: "observe",
          gateVerdict: "blocked_policy",
          latencyMs: plannerLatencyMs,
          tokenUsage,
          detail: "no-auto-dismiss-control",
        });
        stepIndex++;
        if (stagnantSteps >= maxStagnantSteps) {
          phase = "blocked";
          return {
            status: "blocked",
            phase,
            stepIndex,
            reason:
              "Walkthrough stalled calling dismiss_blocker with no auto-dismissible blocker.",
            telemetryEvent,
            state: getState(),
          };
        }
        return {
          status: "continue",
          phase: "verifying",
          stepIndex,
          telemetryEvent,
          state: getState(),
        };
      }
      return executeAndVerify({
        beforeSnapshot: snapshot,
        beforeSanitized: sanitized,
        command: plan.command,
        targetElement: plan.element,
        actionKind: "dismiss_blocker",
        consequenceClass: "observe",
        plannerLatencyMs,
        tokenUsage,
      });
    }

    // 6. DOM actions (click, fill, select, scroll, follow)
    let targetElement = null;
    if (action.kind === "scroll") {
      const requested = action.ref
        ? resolveElement(sanitized, action.ref)
        : null;
      targetElement =
        (requested?.scroll ? requested : null) ??
        (snapshot.elements ?? []).find((el) => el.scroll) ??
        null;
      if (!targetElement) {
        stagnantSteps++;
        warnings.push(
          "No scrollable container found on this page; the page content is already visible.",
        );
        stepIndex++;
        if (stagnantSteps >= maxStagnantSteps) {
          phase = "blocked";
          return {
            status: "blocked",
            phase,
            stepIndex,
            reason: "Walkthrough stalled attempting to scroll a non-scrollable page.",
            state: getState(),
          };
        }
        return { status: "continue", phase: "verifying", stepIndex, state: getState() };
      }
      return executeAndVerify({
        beforeSnapshot: snapshot,
        beforeSanitized: sanitized,
        command: buildCommandForElement(snapshot, targetElement, "scroll", {
          direction: action.direction,
        }),
        targetElement,
        actionKind: "scroll",
        consequenceClass: "observe",
        plannerLatencyMs,
        tokenUsage,
      });
    }

    targetElement = resolveElement(sanitized, action.ref);
    if (!targetElement) {
      warnings.push(
        `Unknown control ref "${action.ref}". Choose a ref from the current controls list (e.g. "e0").`,
      );
      const telemetryEvent = await emitTelemetry({
        plannerActionKind: action.kind,
        gateVerdict: "blocked_policy",
        latencyMs: plannerLatencyMs,
        tokenUsage,
        detail: `unknown-ref:${action.ref}`,
      });
      stepIndex++;
      return { status: "continue", phase: "verifying", stepIndex, telemetryEvent, state: getState() };
    }

    // Loop / repeated ineffective action fence
    const attemptKey = `${stripUrlQuery(currentUrl)}|${action.kind}|${targetElement.targetSelector ?? targetElement.id}|${action.kind === "fill" || action.kind === "select" ? action.text : ""}`;
    const attempts = actionAttempts.get(attemptKey) ?? 0;
    if (attempts >= maxRepeatedActionAttempts) {
      warnings.push(
        `Blocked repeating "${action.kind}" on "${redactSensitiveText(targetElement.label || "")}" (already tried ${attempts} times). Try a different approach, scroll, or ask the user.`,
      );
      const telemetryEvent = await emitTelemetry({
        plannerActionKind: action.kind,
        targetLabel: targetElement.label ?? null,
        gateVerdict: "blocked_loop",
        latencyMs: plannerLatencyMs,
        tokenUsage,
        detail: "repeated-action-fence",
      });
      stepIndex++;
      stagnantSteps++;
      if (stagnantSteps >= maxStagnantSteps) {
        phase = "blocked";
        return {
          status: "blocked",
          phase,
          stepIndex,
          reason: "Loop fence triggered after repeated ineffective actions.",
          telemetryEvent,
          state: getState(),
        };
      }
      return { status: "continue", phase: "verifying", stepIndex, telemetryEvent, state: getState() };
    }

    // Origin check on follow
    if (action.kind === "follow" && targetElement.href) {
      const originAllowed = isOriginAllowed(targetElement.href, {
        currentOrigin: currentUrl ? new URL(currentUrl).origin : undefined,
        allowedOrigins: [...allowedOrigins],
        allowSameSiteSubdomains,
      });
      if (!originAllowed) {
        const destOrigin = (() => {
          try {
            return new URL(targetElement.href).origin;
          } catch {
            return "";
          }
        })();
        return pauseForHandoff(
          {
            kind: "NeedsUntrustedOriginApproval",
            summary: `This link goes to a different website (${destOrigin}). Approve before navigating.`,
            targetOrigin: destOrigin,
            targetLabel: redactSensitiveText(targetElement.label ?? ""),
          },
          null,
          {
            plannerActionKind: "follow",
            targetLabel: targetElement.label ?? null,
            consequenceClass: "commit",
            latencyMs: plannerLatencyMs,
            tokenUsage,
          },
        );
      }
    }

    // Deterministic safety & dark-pattern policy gate
    const classified = classifyElementConsequence(targetElement, {
      action: action.kind,
      hasPaymentCredentialField: sanitized.hasPaymentCredentialField,
    });

    if (classified.consequenceClass === "person_only") {
      return pauseForHandoff(
        {
          kind: classified.handoffKind ?? "NeedsPrivateSignIn",
          summary: `The control "${redactSensitiveText(targetElement.label || targetElement.inferredLabel || "sensitive field")}" requires direct user input.`,
          targetSelector: targetElement.targetSelector ?? null,
          ...(targetElement.fileInput ? { fileInput: targetElement.fileInput } : {}),
        },
        null,
        {
          plannerActionKind: action.kind,
          targetLabel: targetElement.label ?? null,
          consequenceClass: "person_only",
          latencyMs: plannerLatencyMs,
          tokenUsage,
        },
      );
    }

    // Prevent clicking Sponsored listings unless goal explicitly requests sponsored/ads
    const targetShortRef = sanitized.rawIdToShortRef.get(
      targetElement.id ?? targetElement.selector,
    );
    const goalAllowsSponsored = goalMentions(
      goal,
      /\b(?:sponsored|ad|advertisement)\b/i,
    );
    const sponsoredHit = !goalAllowsSponsored
      ? sanitized.observation.darkPatterns.find(
          (dp) =>
            dp.kind === "sponsored-listing" && dp.ref === targetShortRef,
        ) ??
        (() => {
          const card = sanitized.observation.cards.find(
            (c) =>
              Array.isArray(c.darkPatterns) &&
              c.darkPatterns.includes("sponsored-listing") &&
              Array.isArray(c.actionRefs) &&
              c.actionRefs.includes(targetShortRef),
          );
          return card ? { label: card.heading ?? targetElement.label ?? "" } : null;
        })()
      : null;
    if (sponsoredHit && (action.kind === "click" || action.kind === "follow")) {
      warnings.push(
        `Blocked clicking a Sponsored listing ("${sponsoredHit.label ?? ""}"). Choose a non-sponsored organic result instead.`,
      );
      const telemetryEvent = await emitTelemetry({
        plannerActionKind: action.kind,
        targetLabel: targetElement.label ?? null,
        consequenceClass: classified.consequenceClass,
        gateVerdict: "blocked_policy",
        latencyMs: plannerLatencyMs,
        tokenUsage,
        detail: "dark-pattern:sponsored-listing",
      });
      stepIndex++;
      return { status: "continue", phase: "verifying", stepIndex, telemetryEvent, state: getState() };
    }

    const command = buildCommandForElement(snapshot, targetElement, action.kind, {
      ...(action.kind === "fill" || action.kind === "select"
        ? { text: action.text }
        : {}),
    });

    // Irreversible commit gate: ALWAYS require explicit commitGrant or human completion
    if (classified.consequenceClass === "commit" && requireApprovalForCommit) {
      const reviewDetails = {
        actionKind: action.kind,
        targetLabel: redactSensitiveText(
          targetElement.label || targetElement.inferredLabel || "",
        ),
        targetSelector: targetElement.targetSelector ?? null,
        urlOriginPath: stripUrlQuery(currentUrl),
        pageHeading: sanitized.observation.pageHeading,
        reasons: classified.reasons,
        darkPatterns: sanitized.observation.darkPatterns,
        plannerReason: redactSensitiveText(action.reason),
      };
      if (typeof ports.issueCommitGrant === "function") {
        const grantReply = await ports.issueCommitGrant(reviewDetails);
        if (grantReply?.approved && grantReply.commitGrant) {
          actionAttempts.set(attemptKey, attempts + 1);
          return executeAndVerify({
            beforeSnapshot: snapshot,
            beforeSanitized: sanitized,
            command,
            targetElement,
            actionKind: action.kind,
            consequenceClass: "commit",
            plannerLatencyMs,
            tokenUsage,
            commitGrant: grantReply.commitGrant,
            attemptKey,
            note: action.note,
          });
        }
        if (grantReply?.humanCompleted === true) {
          await observePage();
          stepIndex++;
          return { status: "continue", phase: "verifying", stepIndex, state: getState() };
        }
      }
      return pauseForHandoff(
        {
          kind: "NeedsCommitApproval",
          summary: `Please review and approve "${reviewDetails.targetLabel || "this final action"}" before proceeding.`,
          details: reviewDetails,
        },
        { command, targetElement, actionKind: action.kind },
        {
          plannerActionKind: action.kind,
          targetLabel: reviewDetails.targetLabel,
          consequenceClass: "commit",
          latencyMs: plannerLatencyMs,
          tokenUsage,
        },
      );
    }

    actionAttempts.set(attemptKey, attempts + 1);
    return executeAndVerify({
      beforeSnapshot: snapshot,
      beforeSanitized: sanitized,
      command,
      targetElement,
      actionKind: action.kind,
      consequenceClass: classified.consequenceClass,
      plannerLatencyMs,
      tokenUsage,
      attemptKey,
      note: action.note,
    });
  }

  async function run() {
    while (true) {
      const outcome = await step();
      if (outcome.status === "continue") continue;
      if (
        outcome.status === "paused" &&
        typeof ports.onHandoff === "function"
      ) {
        const resolution = await ports.onHandoff(outcome.handoff);
        if (!resolution || resolution.kind === "pause") return outcome;
        const resumed = await resume(resolution);
        if (resumed.status === "continue") continue;
        return resumed;
      }
      return outcome;
    }
  }

  function getState() {
    return {
      runId,
      phase,
      stepIndex,
      maxSteps,
      stagnantSteps,
      urlOriginPath: stripUrlQuery(lastSnapshot?.url ?? ""),
      pendingHandoff,
      history: [...history],
      memoryNotes: [...memoryNotes],
      allowedOrigins: [...allowedOrigins],
    };
  }

  return {
    step,
    resume,
    run,
    getState,
    getTelemetry: () => [...telemetry],
    getTelemetryJsonl: () => formatTelemetryJsonl(telemetry),
  };
}

/**
 * Lightweight transport wrapping any Playwright-compatible `Page` object so
 * upstream Eliza and CLI runners can drive `pageCommand` + `createWalkthroughEngine`
 * directly without duplicating Playwright glue.
 */
export function createPlaywrightWalkthroughTransport(
  page,
  {
    allowedOrigins = [],
    allowSameSiteSubdomains = true,
    allowNewTabFollow = true,
    maxConsequence = "stage",
    useTaskPolicy = true,
    settleMs = 150,
    networkIdleTimeoutMs = 2500,
  } = {},
) {
  const pageCommandSource = pageCommand.toString();
  let seq = 0;

  const isContextDestroyed = (error) =>
    /Execution context was destroyed|Cannot find context with specified id/i.test(
      error instanceof Error ? error.message : String(error),
    );

  const evalInPage = async (command, snapshotId) => {
    return page.evaluate(
      ([source, cmd, snapId]) => {
        const fn = new Function(`return (${source});`)();
        return fn(cmd, snapId, cmd?.validateOnly === true);
      },
      [pageCommandSource, command, snapshotId],
    );
  };

  const waitLoaded = async (waitNetworkIdle = false) => {
    if (typeof page.waitForLoadState === "function") {
      await page
        .waitForLoadState("domcontentloaded", { timeout: 10_000 })
        .catch(() => {});
      if (waitNetworkIdle && networkIdleTimeoutMs > 0) {
        await page
          .waitForLoadState("networkidle", { timeout: networkIdleTimeoutMs })
          .catch(() => {});
      }
    }
  };

  return {
    async snapshot(options = {}) {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        await waitLoaded(attempt > 0);
        const snapshotId = `pw-${Date.now()}-${++seq}`;
        try {
          const result = await evalInPage(
            {
              subaction: "snapshot",
              structuredRegions: options.structuredRegions !== false,
              ...(options.statementRegions === true
                ? { statementRegions: true }
                : {}),
              ...(options.taskPolicy ? { taskPolicy: options.taskPolicy } : {}),
            },
            snapshotId,
          );
          return { ...result, snapshotId };
        } catch (error) {
          lastError = error;
          if (!isContextDestroyed(error) || attempt === 2) throw error;
          if (settleMs > 0) await page.waitForTimeout?.(settleMs);
        }
      }
      throw lastError;
    },
    async execute(command) {
      const origin = new URL(page.url()).origin;
      const permission =
        command.subaction === "fill" &&
        command.protectedValueKind === "verification-code"
          ? "fill-code"
          : command.subaction;
      const taskPolicy =
        command.taskPolicy ??
        (useTaskPolicy && command.expectedSelector
          ? {
              origin,
              allowedOrigins: [...new Set([origin, ...allowedOrigins])],
              allowSameSiteSubdomains,
              allowNewTabFollow,
              maxConsequence,
              expiresAt: Date.now() + 60_000,
              guidanceScope: String(seq),
              expectedSelector: command.expectedSelector,
              targets: [
                { selector: command.expectedSelector, action: permission },
              ],
              ...(command.commitGrant
                ? { commitGrant: command.commitGrant }
                : {}),
            }
          : undefined);
      let result;
      let downloaded = false;
      const onDownload = () => {
        downloaded = true;
      };
      const listenDownload =
        command.validateOnly !== true &&
        typeof page.once === "function" &&
        typeof page.off === "function";
      if (listenDownload) page.once("download", onDownload);
      try {
        result = await evalInPage(
          {
            ...command,
            ...(taskPolicy ? { taskPolicy } : {}),
          },
          null,
        );
      } catch (error) {
        if (command.validateOnly !== true && isContextDestroyed(error)) {
          await waitLoaded(true);
          if (settleMs > 0) await page.waitForTimeout?.(settleMs);
          if (listenDownload) page.off("download", onDownload);
          return {
            dispatched: true,
            completed: false,
            requiresReadback: true,
            navigated: true,
            ...(downloaded ? { downloaded: true } : {}),
          };
        }
        if (listenDownload) page.off("download", onDownload);
        throw error;
      }
      if (command.validateOnly === true) return result;
      if (!result?.error) {
        const shouldWaitIdle = ["click", "follow", "select"].includes(
          command.subaction,
        );
        await waitLoaded(shouldWaitIdle);
        if (settleMs > 0) await page.waitForTimeout?.(settleMs);
      }
      if (listenDownload) page.off("download", onDownload);
      return downloaded && result && typeof result === "object"
        ? { ...result, downloaded: true }
        : result;
    },
    async navigate(url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await waitLoaded(true);
    },
    async goBack() {
      await page.goBack({ waitUntil: "domcontentloaded" });
      await waitLoaded(true);
    },
  };
}
