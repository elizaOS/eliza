// Bare side-effect specifiers still imported directly by the app shell (main.tsx)
// rather than through the manifest-driven loader list. The model-tester entry is
// imported eagerly for the standalone model-tester page; task-coordinator's chat
// inline-widget registration must run before first render.
declare module "@elizaos/app-model-tester";
declare module "@elizaos/plugin-task-coordinator/register";
