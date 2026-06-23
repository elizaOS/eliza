// The renderer side-effect app-module loader list is generated at build time
// from each plugin's `elizaos.appRegister` manifest marker (see
// `vite/app-side-effect-modules.ts`); the app shell re-exports it from this
// virtual module (see `src/plugin-registrations.ts`).
declare module "virtual:eliza-side-effect-app-modules" {
  export const SIDE_EFFECT_APP_MODULE_LOADERS: ReadonlyArray<{
    key: string;
    load: () => Promise<unknown>;
  }>;
}

// Bare side-effect specifiers still imported directly by the app shell (main.tsx)
// rather than through the manifest-driven loader list. The model-tester entry is
// imported eagerly for the standalone model-tester page; task-coordinator's chat
// inline-widget registration must run before first render.
declare module "@elizaos/app-model-tester";
declare module "@elizaos/plugin-task-coordinator/register";
