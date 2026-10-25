/** Minimal deterministic agent-surface host used only by Maps component tests. */

export function useAgentElement<T extends HTMLElement>(descriptor: {
  id: string;
}) {
  return {
    ref: (_element: T | null) => undefined,
    agentProps: { "data-agent-id": descriptor.id },
  };
}
