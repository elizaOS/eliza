// Stub for the optional `@capacitor/app` native bridge — `@elizaos/ui` does not
// declare it as a dependency (the host app supplies it). Tests that exercise the
// deep-link listener `vi.mock("@capacitor/app", ...)`, so this only needs to be a
// resolvable module; the spy factory replaces it.
export const App = {
  addListener: async () => ({ remove: async () => {} }),
  getLaunchUrl: async () => null,
};
export default { App };
