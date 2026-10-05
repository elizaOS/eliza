/**
 * Redacts secrets from scenario report payloads before they are written to disk
 * or surfaced in trajectories. Walks object keys whose normalized name matches
 * a sensitive-key set (tokens, passwords, api keys, authorization);
 * `redactedSensitiveActionResult` produces a placeholder result for actions whose
 * output is sensitive as a whole. Consumed by interceptor.ts and executor.ts.
 *
 * The walk is iterative and masks ancestor cycles, so deeply nested input
 * cannot overflow the JavaScript stack. Complete acyclic reports are
 * preserved regardless of their depth or number of fields.
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
  const descriptorFor = (key: string): PropertyDescriptor | undefined =>
    Object.getOwnPropertyDescriptor(record, key);
  const dataValue = (key: string): unknown => {
    const descriptor = descriptorFor(key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const keyDescriptor = descriptorFor("key");
  const hasCredentialMetadata = [
    "retrievedAt",
    "credentialScopeId",
    "childSessionId",
  ].some((key) => descriptorFor(key) !== undefined);
  return (
    (typeof dataValue("key") === "string" ||
      (keyDescriptor !== undefined && !("value" in keyDescriptor))) &&
    hasCredentialMetadata
  );
}

function shouldRedactKey(
  key: string,
  parent: unknown,
  matchesExplicitPath: boolean,
  explicitKeys: ReadonlySet<string>,
): boolean {
  if (explicitKeys.has(key) || matchesExplicitPath) {
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
  interface ExplicitPathNode {
    terminal: boolean;
    children: Map<string, ExplicitPathNode>;
  }
  interface VisitEntry {
    key: string;
    descriptor: PropertyDescriptor | undefined;
  }
  interface VisitFrame {
    source: object;
    target: Record<string, unknown> | unknown[];
    entries: VisitEntry[];
    explicitPathNode: ExplicitPathNode | undefined;
    index: number;
  }

  const entriesFor = (source: object): VisitEntry[] => {
    if (Array.isArray(source)) {
      return Array.from({ length: source.length }, (_, index) => ({
        key: String(index),
        descriptor: Object.getOwnPropertyDescriptor(source, index),
      }));
    }
    return Object.keys(source).map((key) => ({
      key,
      descriptor: Object.getOwnPropertyDescriptor(source, key),
    }));
  };

  const explicitRoot: ExplicitPathNode = {
    terminal: false,
    children: new Map(),
  };
  const explicitKeys = new Set<string>();
  for (const configuredPath of explicitFieldPaths) {
    const path = normalizedPath(configuredPath);
    if (!path) continue;
    const parts = path.split(".");
    if (parts.length === 1) explicitKeys.add(parts[0]);
    let node = explicitRoot;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        child = { terminal: false, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.terminal = true;
  }

  if (!value || typeof value !== "object") return value;

  const ancestors = new WeakSet<object>();
  const root: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? []
    : {};
  const stack: VisitFrame[] = [
    {
      source: value,
      target: root,
      entries: entriesFor(value),
      explicitPathNode: explicitRoot,
      index: 0,
    },
  ];
  ancestors.add(value);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.entries.length) {
      ancestors.delete(frame.source);
      stack.pop();
      continue;
    }

    const { key, descriptor } = frame.entries[frame.index];
    frame.index += 1;
    const explicitPathNode = frame.explicitPathNode?.children.get(key);
    const entry =
      descriptor && "value" in descriptor ? descriptor.value : REDACTED;
    let redacted: unknown;
    if (
      shouldRedactKey(
        key,
        frame.source,
        explicitPathNode?.terminal === true,
        explicitKeys,
      )
    ) {
      redacted = REDACTED;
    } else if (!descriptor || !("value" in descriptor)) {
      redacted = REDACTED;
    } else if (!entry || typeof entry !== "object") {
      redacted = entry;
    } else if (ancestors.has(entry)) {
      redacted = REDACTED;
    } else {
      redacted = Array.isArray(entry) ? [] : {};
      ancestors.add(entry);
      stack.push({
        source: entry,
        target: redacted as Record<string, unknown> | unknown[],
        entries: entriesFor(entry),
        explicitPathNode,
        index: 0,
      });
    }

    if (Array.isArray(frame.target)) {
      frame.target.push(redacted);
    } else {
      Object.defineProperty(frame.target, key, {
        value: redacted,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }

  return root;
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
