/** Supports app-core build, packaging, or development orchestration for desktop startup embedding warmup policy mjs. */
const SKIP_ENV = "ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP";
const OPT_IN_ENV = "ELIZA_ENABLE_STARTUP_LOCAL_EMBEDDING_WARMUP";
const DEFER_ENV = "ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP";

function isTruthyEnvValue(value) {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

export function resolveDesktopStartupEmbeddingWarmupPolicy(env = process.env) {
  const skipRaw = env[SKIP_ENV]?.trim();
  if (skipRaw) {
    return {
      env: { [SKIP_ENV]: skipRaw },
      effective: isTruthyEnvValue(skipRaw) ? "skipped" : "startup background",
      source: `env set - ${SKIP_ENV}=${skipRaw}`,
      change: `unset ${SKIP_ENV}, or set ${OPT_IN_ENV}=1 when no skip override is present`,
    };
  }

  if (isTruthyEnvValue(env.CI)) {
    return {
      env: { [SKIP_ENV]: "1" },
      effective: "skipped",
      source: "default - CI",
      change: `set ${SKIP_ENV}=0 to allow CI startup warmup`,
    };
  }

  const optInRaw = env[OPT_IN_ENV]?.trim();
  if (isTruthyEnvValue(optInRaw)) {
    // Runtime warmup now DEFERS by default, so opting into process-entry
    // warmup requires an explicit `ELIZA_DEFER_...=0` in the child env —
    // injecting nothing would leave the child on the deferred default.
    return {
      env: { [DEFER_ENV]: "0" },
      effective: "startup background",
      source: `env set - ${OPT_IN_ENV}=${optInRaw}`,
      change: `unset ${OPT_IN_ENV} for default desktop fast startup`,
    };
  }

  return {
    env: { [DEFER_ENV]: "1" },
    effective: "deferred background",
    source: "default - desktop dev fast startup",
    change: `set ${OPT_IN_ENV}=1 to start warmup during runtime bootstrap, or ${SKIP_ENV}=1 to disable it`,
  };
}
