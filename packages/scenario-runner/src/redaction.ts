/**
 * Redacts secrets from scenario report payloads before they are written to disk
 * or surfaced in trajectories. Walks object keys whose normalized name matches
 * a sensitive-key set (tokens, passwords, api keys, authorization);
 * `redactedSensitiveActionResult` produces a placeholder result for actions whose
 * output is sensitive as a whole. Consumed by interceptor.ts and executor.ts.
 *
 * The walk is depth- and visit-bounded and breaks cycles. A cyclic or
 * 20k-deep payload on origin blew the stack (cyclic ~5s, 10k-deep ~1.2s)
 * while persisting the aggregate report.
 */
const REDACTED = "[REDACTED]" as const;

/** Nesting ceiling. Honest reports are a handful of objects deep. */
export const MAX_SCENARIO_REDACT_DEPTH = 32;
/** Node visit ceiling so a wide hostile array cannot pin the runner. */
export const MAX_SCENARIO_REDACT_VISIT = 8192;

const DEFAULT_SENSITIVE_KEYS = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "authorization",
  "bearer",
  "id_token",
  "idtoken",
  "password",
  "refresh_token",
  "refreshtoken",
  "scopedtoken",
  "secret",
  "token",
]);

function normalizedKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function normalizedPath(path: string): string {
  return path
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(".");
}

function objectHasCredentialValueShape(parent: unknown): boolean {
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
    return false;
  }
  const record = parent as Record<string, unknown>;
  return (
    typeof record.key === "string" &&
    (record.retrievedAt !== undefined ||
      record.credentialScopeId !== undefined ||
      record.childSessionId !== undefined)
  );
}

function shouldRedactKey(
  key: string,
  path: readonly string[],
  parent: unknown,
  explicitPaths: ReadonlySet<string>,
): boolean {
  const dotPath = path.join(".");
  if (explicitPaths.has(key) || explicitPaths.has(dotPath)) {
    return true;
  }
  const normalized = normalizedKey(key);
  if (DEFAULT_SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  if (normalized === "value" && objectHasCredentialValueShape(parent)) {
    return true;
  }
  return false;
}

export function redactForScenarioReport(
  value: unknown,
  explicitFieldPaths: readonly string[] = [],
): unknown {
  const explicitPaths = new Set(
    explicitFieldPaths.map(normalizedPath).filter(Boolean),
  );
  const seen = new WeakSet<object>();
  let visits = 0;

  function visit(
    entry: unknown,
    path: string[],
    parent: unknown,
    depth: number,
  ): unknown {
    if (visits >= MAX_SCENARIO_REDACT_VISIT) {
      return REDACTED;
    }
    visits += 1;
    const key = path[path.length - 1];
    if (key && shouldRedactKey(key, path, parent, explicitPaths)) {
      return REDACTED;
    }
    if (Array.isArray(entry)) {
      if (depth >= MAX_SCENARIO_REDACT_DEPTH || seen.has(entry)) {
        return REDACTED;
      }
      seen.add(entry);
      const out: unknown[] = [];
      for (let index = 0; index < entry.length; index += 1) {
        if (visits >= MAX_SCENARIO_REDACT_VISIT) {
          out.push(REDACTED);
          break;
        }
        path.push(String(index));
        out.push(visit(entry[index], path, entry, depth + 1));
        path.pop();
      }
      return out;
    }
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    if (depth >= MAX_SCENARIO_REDACT_DEPTH || seen.has(entry)) {
      return REDACTED;
    }
    seen.add(entry);
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(entry)) {
      if (visits >= MAX_SCENARIO_REDACT_VISIT) {
        out[childKey] = REDACTED;
        break;
      }
      path.push(childKey);
      out[childKey] = visit(childValue, path, entry, depth + 1);
      path.pop();
    }
    return out;
  }

  return visit(value, [], undefined, 0);
}

export function redactedSensitiveActionResult(actionName: string): {
  actionName: string;
  suppressed: true;
  reason: "sensitive_action_result";
} {
  return {
    actionName,
    suppressed: true,
    reason: "sensitive_action_result",
  };
}
