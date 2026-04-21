/**
 * Side-effect entry that app hosts (Capacitor, Electrobun, web) import
 * to ensure the task-coordinator surfaces are active in the current
 * bundle. Components are already consumed directly by app-core via
 * subpath imports (`@elizaos/app-task-coordinator/CodingAgentControlChip`,
 * `@elizaos/app-task-coordinator/PtyConsoleBase`, etc.), so this file's
 * job is to be an explicit, greppable anchor for that wiring and to
 * hold any future slot-registration calls without the host app having
 * to care about each one individually.
 *
 * Keep this as a side-effect-only module — do not add named exports.
 * Host apps import it for its reserved module identity:
 *   `import "@elizaos/app-task-coordinator/register-slots";`
 */
export {};
