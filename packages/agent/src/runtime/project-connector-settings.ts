/**
 * Projects connector configuration consumed after the Character boot boundary.
 * Connector objects are cloned so runtime services cannot mutate the persisted
 * configuration object while resolving accounts or policy.
 */
import type { JsonValue } from "@elizaos/core";

export function projectConnectorSettings(
  settings: Record<string, JsonValue | undefined>,
  connectors: unknown,
): Record<string, JsonValue | undefined> {
  if (
    !connectors ||
    typeof connectors !== "object" ||
    Array.isArray(connectors)
  ) {
    return settings;
  }
  const slack = (connectors as Record<string, unknown>).slack;
  if (!slack || typeof slack !== "object" || Array.isArray(slack)) {
    return settings;
  }
  return { ...settings, slack: structuredClone(slack) as JsonValue };
}
