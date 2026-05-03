const STRIPPED_ENV_KEYS = [
  "ELIZA_API_PORT",
  "ELIZA_PORT",
  "ELIZA_API_BASE",
  "ELIZA_API_BASE_URL",
  "ELIZA_API_PORT",
  "ELIZA_DESKTOP_API_BASE",
  "ELIZA_DESKTOP_TEST_PARTITION",
  "ELIZA_RENDERER_URL",
  "ELIZA_STARTUP_EVENTS_FILE",
  "ELIZA_STARTUP_SESSION_ID",
  "ELIZA_STARTUP_STATE_FILE",
  "ELIZA_TEST_WINDOWS_APPDATA_PATH",
  "ELIZA_TEST_WINDOWS_BACKEND_PORT",
  "ELIZA_TEST_WINDOWS_INSTALL_DIR",
  "ELIZA_TEST_WINDOWS_LAUNCHER_PATH",
  "ELIZA_TEST_WINDOWS_LOCALAPPDATA_PATH",
  "ELIZA_WINDOWS_SMOKE_REQUIRE_INSTALLER",
  "VITE_DEV_SERVER_URL",
] as const;

export function createPackagedWindowsAppEnv(args: {
  baseEnv: NodeJS.ProcessEnv;
  apiBase: string;
  appData: string;
  localAppData: string;
}): NodeJS.ProcessEnv {
  const env = {
    ...args.baseEnv,
  };

  for (const key of STRIPPED_ENV_KEYS) {
    delete env[key];
  }

  return {
    ...env,
    ELIZA_DESKTOP_TEST_API_BASE: args.apiBase,
    ELIZA_DESKTOP_TEST_PARTITION: "persist:bootstrap-isolated",
    ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
    ELECTROBUN_CONSOLE: "1",
    // Redirect both Windows profile roots so the packaged shell and the
    // explicit bootstrap partition stay isolated from stale host-machine CEF
    // and runtime state on each test run.
    APPDATA: args.appData,
    LOCALAPPDATA: args.localAppData,
  };
}
