const CONFIG_KEY = "eliza.background.config";
const LAST_WAKE_KEY = "eliza.background.lastWake";
const LAST_RESULT_KEY = "eliza.background.lastResult";

function eventDetails(args) {
  if (args && typeof args === "object" && args.dataArgs && typeof args.dataArgs === "object") {
    return args.dataArgs;
  }
  return args && typeof args === "object" ? args : {};
}

function kvGetJson(key) {
  try {
    if (typeof CapacitorKV === "undefined") return {};
    const entry = CapacitorKV.get(key);
    return entry && typeof entry.value === "string" && entry.value
      ? JSON.parse(entry.value)
      : {};
  } catch {
    return {};
  }
}

function kvSetJson(key, value) {
  try {
    if (typeof CapacitorKV !== "undefined") {
      CapacitorKV.set(key, JSON.stringify(value));
    }
  } catch {
    // Best effort diagnostics only.
  }
}

function joinUrl(base, pathname) {
  if (!base || typeof base !== "string") return null;
  return `${base.replace(/\/+$/, "")}${pathname}`;
}

function runDueUrl(config) {
  if (typeof config.runDueUrl === "string" && config.runDueUrl) {
    return config.runDueUrl;
  }
  if (typeof config.localApiBase === "string" && config.localApiBase) {
    return joinUrl(config.localApiBase, "/api/background/run-due-tasks");
  }
  if (typeof config.apiBase === "string" && config.apiBase && config.mode !== "local") {
    return joinUrl(config.apiBase, "/api/background/run-due-tasks");
  }
  return null;
}

function isIosLocalIttpRunner(config) {
  return (
    config &&
    config.mode === "local" &&
    config.platform === "ios" &&
    config.localRouteKernel === "ittp"
  );
}

async function runWake(args) {
  const firedAt = new Date().toISOString();
  const details = eventDetails(args);
  const config = { ...kvGetJson(CONFIG_KEY), ...details };
  const endpoint = runDueUrl(config);
  const wake = {
    event: "wake",
    source: "capacitor-background-runner",
    firedAt,
    mode: config.mode || "unknown",
    platform: config.platform || "unknown",
  };
  kvSetJson(LAST_WAKE_KEY, wake);

  if (!endpoint && isIosLocalIttpRunner(config)) {
    const skipped = {
      ...wake,
      ok: true,
      skipped: true,
      reason: "ios_ittp_route_kernel_unavailable_in_background_jscontext",
    };
    kvSetJson(LAST_RESULT_KEY, skipped);
    return skipped;
  }

  if (!endpoint) {
    const skipped = {
      ...wake,
      ok: true,
      skipped: true,
      reason: "no_background_task_endpoint",
    };
    kvSetJson(LAST_RESULT_KEY, skipped);
    return skipped;
  }

  const headers = { "Content-Type": "application/json" };
  if (typeof config.authToken === "string" && config.authToken) {
    headers.Authorization = `Bearer ${config.authToken}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(wake),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  const result = {
    ...wake,
    ok: response.ok,
    status: response.status,
    body,
  };
  kvSetJson(LAST_RESULT_KEY, result);

  if (!response.ok) {
    throw new Error(`run-due-tasks failed: ${response.status}`);
  }
  return result;
}

addEventListener("wake", (resolve, reject, args) => {
  runWake(args).then(resolve).catch((error) => {
    console.error("[eliza-tasks] wake failed", error);
    reject(error);
  });
});

addEventListener("configure", (resolve, reject, args) => {
  try {
    const next = {
      ...kvGetJson(CONFIG_KEY),
      ...eventDetails(args),
      configuredAt: new Date().toISOString(),
    };
    kvSetJson(CONFIG_KEY, next);
    resolve({ event: "configure", configured: true });
  } catch (error) {
    reject(error);
  }
});

addEventListener("register", (resolve, reject, args) => {
  try {
    const details = eventDetails(args);
    kvSetJson(CONFIG_KEY, {
      ...kvGetJson(CONFIG_KEY),
      ...details,
      registeredAt: new Date().toISOString(),
    });
    resolve({ event: "register", registered: true });
  } catch (error) {
    reject(error);
  }
});

addEventListener("cancel", (resolve, reject) => {
  try {
    resolve({ event: "cancel", cancelled: true });
  } catch (error) {
    reject(error);
  }
});
