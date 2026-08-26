/**
 * Stub for `@elizaos/ui/agent-surface` — the inert `useAgentElement` hook every
 * view's jsdom test mocks so the agent-instrumented controls render outside an
 * agent-surface provider. Aliased in place of the real subpath export.
 */

interface HarnessAgentElementDescriptor {
  id: string;
  role?: string;
  label: string;
  status?: string;
  sensitive?: boolean;
  [key: string]: unknown;
}

export function useAgentElement<_T = unknown>(
  descriptor: HarnessAgentElementDescriptor,
): {
  ref: () => void;
  agentProps: Record<string, string>;
} {
  return {
    ref: () => {},
    agentProps: {
      "data-agent-id": descriptor.id,
      "data-agent-role": descriptor.role ?? "region",
      "data-agent-label": descriptor.label,
      ...(descriptor.status ? { "data-state": descriptor.status } : {}),
      ...(descriptor.sensitive ? { "data-agent-sensitive": "true" } : {}),
      ...(descriptor.role && descriptor.role !== "region"
        ? { "aria-label": descriptor.label }
        : {}),
    },
  };
}
