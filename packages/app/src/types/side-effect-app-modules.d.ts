// Bare side-effect specifiers still imported directly by the app shell (main.tsx)
// rather than through the manifest-driven loader list: task-coordinator's chat
// inline-widget registration must run before first render.
declare module "@elizaos/plugin-task-coordinator/register";
