/**
 * React hook for A2A (Agent-to-Agent) protocol utilities.
 *
 * Provides access to both custom Polyagent methods and official A2A protocol
 * functionality. The A2A protocol enables agents to communicate and coordinate
 * with each other through standardized message passing.
 *
 * @returns An object containing A2A utility methods and debug helpers.
 * Currently returns a placeholder debug function, with full A2A utilities
 * planned for future implementation.
 *
 * @example
 * ```tsx
 * const { debug } = useA2A();
 * debug(); // Logs available A2A methods
 * ```
 */
export const useA2A = () => {
  return {
    // Placeholder for future A2A utilities
    // Could include: task subscriptions, streaming hooks, etc.
    debug: () => {
      console.log("A2A utilities available");
      console.log("Custom methods: /api/a2a (58 methods)");
      console.log("A2A: /api/a2a (message/send)");
    },
  };
};
