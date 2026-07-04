/**
 * Marks agent-surface elements as sensitive so they cannot be read or filled
 * through the agent view-instrumentation surface.
 */
import type { AgentElementDescriptor } from "./types";

export const SENSITIVE_AGENT_ELEMENT_REASON =
  "sensitive element cannot be read or filled through the agent surface";

const SENSITIVE_FIELD_PATTERN =
  /\b(password|passcode|passphrase|secret|token|api[\s_-]*key|private[\s_-]*key|seed[\s_-]*phrase|mnemonic|bearer|credential|client[\s_-]*secret|access[\s_-]*token|refresh[\s_-]*token|jwt|otp|one[\s_-]*time[\s_-]*code)\b/i;

function hasSensitiveText(value: unknown): boolean {
  return typeof value === "string" && SENSITIVE_FIELD_PATTERN.test(value);
}

function elementLabels(el: HTMLElement): string[] {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return Array.from(el.labels ?? [])
      .map((label) => label.textContent ?? "")
      .filter(Boolean);
  }
  return [];
}

export function isSensitiveAgentElement(
  descriptor: Pick<
    AgentElementDescriptor,
    "id" | "label" | "group" | "description" | "sensitive"
  >,
  el: HTMLElement | null | undefined,
): boolean {
  if (descriptor.sensitive === true) return true;

  if (el) {
    const explicit = el.getAttribute("data-agent-sensitive");
    if (explicit === "true" || explicit === "1") return true;
    if (el instanceof HTMLInputElement) {
      if (el.type === "password") return true;
      if (el.autocomplete === "one-time-code") return true;
    }
  }

  const searchableText = [
    descriptor.id,
    descriptor.label,
    descriptor.group,
    descriptor.description,
    el?.getAttribute("name"),
    el?.getAttribute("id"),
    el?.getAttribute("aria-label"),
    el?.getAttribute("placeholder"),
    el?.getAttribute("autocomplete"),
    ...(el ? elementLabels(el) : []),
  ];
  return searchableText.some(hasSensitiveText);
}
