/**
 * Owns the executable contract for development API children: source-aware
 * runtime argv, environment isolation, and the final spawn boundary shared by
 * the browser and desktop development entrypoints.
 */
import { spawn } from "node:child_process";

const DEV_TEST_MOCK_ENV_KEYS = [
  "ELIZA_MOCK_GOOGLE_BASE",
  "ELIZA_MOCK_TWILIO_BASE",
  "ELIZA_MOCK_WHATSAPP_BASE",
  "ELIZA_MOCK_X_BASE",
  "ELIZA_MOCK_CALENDLY_BASE",
];

const VITE_RENDERER_ONLY_MOBILE_ENV_KEYS = [
  "VITE_ELIZA_IOS_RUNTIME_MODE",
  "VITE_ELIZA_MOBILE_RUNTIME_MODE",
  "VITE_ELIZA_IOS_API_BASE",
  "VITE_ELIZA_MOBILE_API_BASE",
  "VITE_ELIZA_IOS_FULL_BUN_AVAILABLE",
];

export function buildDevChildEnv(baseEnv) {
  const env = { ...baseEnv };
  const strippedTestMockKeys = [];
  if (env.ELIZA_DEV_ALLOW_TEST_MOCKS !== "1") {
    for (const key of DEV_TEST_MOCK_ENV_KEYS) {
      if (key in env) {
        delete env[key];
        strippedTestMockKeys.push(key);
      }
    }
  }
  return { env, strippedTestMockKeys };
}

export function buildDevApiChildEnv(baseEnv) {
  const result = buildDevChildEnv(baseEnv);
  for (const key of VITE_RENDERER_ONLY_MOBILE_ENV_KEYS) {
    delete result.env[key];
  }
  if (!result.env.ELIZA_WALLET_OS_STORE?.trim()) {
    result.env.ELIZA_WALLET_OS_STORE = "0";
  }
  return result;
}

export function buildDevApiChildArgs({ runtime, entryPath, watch = false }) {
  if (runtime !== "bun" && runtime !== "node") {
    throw new TypeError(`Unsupported development API runtime: ${runtime}`);
  }
  return [
    ...(runtime === "bun" ? ["--no-install"] : []),
    "--conditions=eliza-source",
    ...(runtime === "node" ? ["--import", "tsx"] : []),
    ...(watch ? ["--watch"] : []),
    entryPath,
  ];
}

export function spawnDevApiChild({
  executable,
  runtime,
  entryPath,
  watch = false,
  cwd,
  env,
  stdio,
  detached,
  spawnImpl = spawn,
}) {
  return spawnImpl(
    executable,
    buildDevApiChildArgs({ runtime, entryPath, watch }),
    {
      cwd,
      env,
      stdio,
      ...(detached === undefined ? {} : { detached }),
    },
  );
}
