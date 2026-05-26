import type {
  FirstRunClientLike as ClientLike,
  HistoryLike,
  FirstRunPatchState as PatchState,
  StorageLike,
} from "./types";

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";
const SETUP_STEP_STORAGE_KEY = "eliza:setup:step";
const FIRST_RUN_COMPLETE_STORAGE_KEY = "eliza:first-run-complete";
const FORCE_FRESH_FIRST_RUN_STORAGE_KEY = "elizaos:first-run:force-fresh";
const RESET_QUERY_PARAM = "reset";
const PATCH_STATE = Symbol.for("elizaos.forceFreshFirstRunPatch");
type PatchableClient = ClientLike & { [PATCH_STATE]?: PatchState };

type FirstRunStatus = { complete: boolean } & Record<string, unknown>;

function getStorage(
  storage?: StorageLike | null,
): StorageLike | null | undefined {
  if (storage) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage;
}

export function isForceFreshFirstRunEnabled(
  storage?: StorageLike | null,
): boolean {
  const resolvedStorage = getStorage(storage);
  if (!resolvedStorage) {
    return false;
  }

  try {
    return resolvedStorage.getItem(FORCE_FRESH_FIRST_RUN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function enableForceFreshFirstRun(storage?: StorageLike | null): void {
  const resolvedStorage = getStorage(storage);
  if (!resolvedStorage) {
    return;
  }

  try {
    resolvedStorage.setItem(FORCE_FRESH_FIRST_RUN_STORAGE_KEY, "1");
  } catch {
    // Ignore storage failures during startup.
  }
}

export function clearForceFreshFirstRun(storage?: StorageLike | null): void {
  const resolvedStorage = getStorage(storage);
  if (!resolvedStorage) {
    return;
  }

  try {
    resolvedStorage.removeItem(FORCE_FRESH_FIRST_RUN_STORAGE_KEY);
  } catch {
    // Ignore storage failures during startup.
  }
}

export function applyForceFreshFirstRunReset(args?: {
  url?: URL;
  storage?: StorageLike | null;
  history?: HistoryLike | null;
}): boolean {
  const resolvedStorage = getStorage(args?.storage);
  const resolvedUrl =
    args?.url ??
    (typeof window !== "undefined" ? new URL(window.location.href) : null);
  const resolvedHistory =
    args?.history ?? (typeof window !== "undefined" ? window.history : null);

  if (!resolvedUrl?.searchParams.has(RESET_QUERY_PARAM)) {
    return false;
  }

  if (resolvedStorage) {
    try {
      resolvedStorage.removeItem(ACTIVE_SERVER_STORAGE_KEY);
      resolvedStorage.removeItem(SETUP_STEP_STORAGE_KEY);
      resolvedStorage.removeItem(FIRST_RUN_COMPLETE_STORAGE_KEY);
      resolvedStorage.setItem(FORCE_FRESH_FIRST_RUN_STORAGE_KEY, "1");
    } catch {
      // Ignore storage failures during startup.
    }
  }

  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem("elizaos_api_base");
      window.sessionStorage.removeItem("elizaos_api_base");
    } catch {
      // Ignore storage failures during startup.
    }
  }

  resolvedUrl.searchParams.delete(RESET_QUERY_PARAM);
  resolvedHistory?.replaceState(null, "", resolvedUrl.toString());
  return true;
}

export function installForceFreshFirstRunClientPatch(
  client: ClientLike,
  storage?: StorageLike | null,
): () => void {
  const patchableClient = client as PatchableClient;
  const existingPatch = patchableClient[PATCH_STATE];
  if (existingPatch) {
    return () => {};
  }

  const originalGetConfig = client.getConfig.bind(client);
  const originalGetFirstRunStatus = client.getFirstRunStatus.bind(client);
  const originalSubmitFirstRun = client.submitFirstRun.bind(client);

  patchableClient[PATCH_STATE] = {
    getConfig: client.getConfig,
    getFirstRunStatus: client.getFirstRunStatus,
    submitFirstRun: client.submitFirstRun,
  } satisfies PatchState;

  client.getConfig = async () => {
    if (isForceFreshFirstRunEnabled(storage)) {
      return {};
    }
    return originalGetConfig();
  };

  client.getFirstRunStatus = async () => {
    const status = (await originalGetFirstRunStatus()) as FirstRunStatus;
    if (!isForceFreshFirstRunEnabled(storage)) {
      return status;
    }
    return { ...status, complete: false };
  };

  client.submitFirstRun = async (...args) => {
    await originalSubmitFirstRun(...args);
    clearForceFreshFirstRun(storage);
  };

  return () => {
    const patchState = patchableClient[PATCH_STATE];
    if (!patchState) {
      return;
    }
    client.getConfig = patchState.getConfig;
    client.getFirstRunStatus = patchState.getFirstRunStatus;
    client.submitFirstRun = patchState.submitFirstRun;
    delete patchableClient[PATCH_STATE];
  };
}
