/**
 * Settings → Connectors section.
 *
 * Renders one inline `<details>` row per active connector plugin. The summary
 * carries the brand icon + name + enable/disable Switch + status dot; the
 * expanded body dispatches to the existing per-connector setup panel by
 * plugin id.
 *
 * The id→panel dispatch is hardcoded — AGENTS.md commandment 5 (zero
 * polymorphism for runtime type branching) explicitly allows this for
 * adapter/target registries. There are a small, known set of connectors,
 * each with its own bespoke setup surface.
 */
export declare function ConnectorsSection(): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ConnectorsSection.d.ts.map