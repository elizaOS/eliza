/**
 * @module mappings
 * @description Hook mapping resolution and template rendering.
 *
 * Mappings let you define how arbitrary webhook payloads (like Gmail Pub/Sub)
 * are transformed into wake or agent actions.
 *
 * Config shape (from Otto/openclaw):
 *   hooks.mappings: [
 *     {
 *       match: { path: "gmail" },
 *       action: "agent",
 *       name: "Gmail",
 *       sessionKey: "hook:gmail:{{messages[0].id}}",
 *       messageTemplate: "New email from {{messages[0].from}}...",
 *       wakeMode: "now",
 *       deliver: true,
 *       channel: "last",
 *     }
 *   ]
 */

export interface HookMapping {
  match?: { path?: string; source?: string };
  action?: 'wake' | 'agent';
  wakeMode?: 'now' | 'next-heartbeat';
  name?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  channel?: string;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  allowUnsafeExternalContent?: boolean;
}

/**
 * Find a mapping that matches the given hook name (path segment after /hooks/).
 */
export function findMapping(
  mappings: HookMapping[],
  hookName: string,
  payload: Record<string, unknown>,
): HookMapping | undefined {
  for (const mapping of mappings) {
    if (mapping.match?.path && mapping.match.path === hookName) {
      return mapping;
    }
    if (mapping.match?.source && typeof payload.source === 'string') {
      if (payload.source === mapping.match.source) {
        return mapping;
      }
    }
  }
  return undefined;
}

/**
 * Render a Mustache-style template against a data object.
 *
 * Supports:
 *   {{field}}            -> data.field
 *   {{nested.field}}     -> data.nested.field
 *   {{array[0].field}}   -> data.array[0].field
 *
 * Unresolved placeholders are left as-is.
 */
export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, expr: string) => {
    const path = expr.trim();
    const value = resolvePath(data, path);
    if (value === undefined || value === null) {
      return `{{${expr}}}`;
    }
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    return String(value);
  });
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  // Handle array indexing: messages[0].from -> messages.0.from
  const normalizedPath = path.replace(/\[(\d+)\]/g, '.$1');
  const parts = normalizedPath.split('.');

  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Apply a mapping to a payload, producing the final wake or agent parameters.
 */
export function applyMapping(
  mapping: HookMapping,
  hookName: string,
  payload: Record<string, unknown>,
): {
  action: 'wake' | 'agent';
  text?: string;
  message?: string;
  name?: string;
  sessionKey?: string;
  wakeMode: 'now' | 'next-heartbeat';
  deliver?: boolean;
  channel?: string;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
} {
  const action = mapping.action ?? 'agent';
  const wakeMode = mapping.wakeMode ?? 'now';

  if (action === 'wake') {
    const textTemplate = mapping.textTemplate ?? mapping.messageTemplate;
    const text = textTemplate
      ? renderTemplate(textTemplate, payload)
      : typeof payload.text === 'string'
        ? payload.text
        : `Webhook received: ${hookName}`;

    return { action: 'wake', text, wakeMode };
  }

  // action === 'agent'
  const messageTemplate = mapping.messageTemplate;
  const message = messageTemplate
    ? renderTemplate(messageTemplate, payload)
    : typeof payload.message === 'string'
      ? payload.message
      : `Webhook payload from ${hookName}`;

  const sessionKey = mapping.sessionKey
    ? renderTemplate(mapping.sessionKey, payload)
    : `hook:${hookName}:${Date.now()}`;

  return {
    action: 'agent',
    message,
    name: mapping.name ?? hookName,
    sessionKey,
    wakeMode,
    deliver: mapping.deliver ?? true,
    channel: mapping.channel ?? 'last',
    to: mapping.to,
    model: mapping.model,
    thinking: mapping.thinking,
    timeoutSeconds: mapping.timeoutSeconds,
  };
}
