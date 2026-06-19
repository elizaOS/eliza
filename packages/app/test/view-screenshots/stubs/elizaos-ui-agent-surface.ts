/**
 * Stub for `@elizaos/ui/agent-surface` — the inert `useAgentElement` hook every
 * view's jsdom test mocks so the agent-instrumented controls render outside an
 * agent-surface provider. Aliased in place of the real subpath export.
 */

export function useAgentElement<_T = unknown>(): {
  ref: () => void;
  agentProps: Record<string, never>;
} {
  return { ref: () => {}, agentProps: {} };
}
