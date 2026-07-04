/**
 * Redacts secrets from scenario report payloads before they are written to disk
 * or surfaced in trajectories. Recursively masks any object key whose normalized
 * name matches a sensitive-key set (tokens, passwords, api keys, authorization);
 * `redactedSensitiveActionResult` produces a placeholder result for actions whose
 * output is sensitive as a whole. Consumed by interceptor.ts and executor.ts.
 */
const REDACTED = "[REDACTED]" as const;

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

  function visit(entry: unknown, path: string[], parent: unknown): unknown {
    const key = path[path.length - 1];
    if (key && shouldRedactKey(key, path, parent, explicitPaths)) {
      return REDACTED;
    }
    if (Array.isArray(entry)) {
      return entry.map((item, index) =>
        visit(item, [...path, String(index)], entry),
      );
    }
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(entry)) {
      out[childKey] = visit(childValue, [...path, childKey], entry);
    }
    return out;
  }

  return visit(value, [], undefined);
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
