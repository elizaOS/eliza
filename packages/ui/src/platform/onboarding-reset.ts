import type {
  OnboardingClientLike as ClientLike,
  HistoryLike,
  OnboardingPatchState as PatchState,
  StorageLike,
} from "./types";

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";
const ONBOARDING_STEP_STORAGE_KEY = "eliza:onboarding:step";
const LEGACY_ONBOARDING_STEP_STORAGE_KEY = "eliza:onboarding-step";
const ONBOARDING_COMPLETE_STORAGE_KEY = "eliza:onboarding-complete";
const FORCE_FRESH_ONBOARDING_STORAGE_KEY = "elizaos:onboarding:force-fresh";
const RESET_QUERY_PARAM = "reset";
const PATCH_STATE = Symbol.for("elizaos.forceFreshOnboardingPatch");
type PatchableClient = ClientLike & { [PATCH_STATE]?: PatchState };

type OnboardingStatus = { complete: boolean } & Record<string, unknown>;

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

export function isForceFreshOnboardingEnabled(
  storage?: StorageLike | null,
): boolean {
  const resolvedStorage = getStorage(storage);
  if (!resolvedStorage) {
    return false;
  }

  try {
    return resolvedStorage.getItem(FORCE_FRESH_ONBOARDING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function enableForceFreshOnboarding(storage?: StorageLike | null): void {
  const resolvedStorage = getStorage(storage);
  if (!resolvedStorage) {
    return;
  }

  try {
    resolvedStorage.setItem(FORCE_FRESH_ONBOARDING_STORAGE_KEY, "1");
  } catch {
    // Ignore storage failures during startup.
  }
}

export function clearForceFreshOnboarding(storage?: StorageLike | null): void {
  const resolvedStorage = getStorage(storage);
  if (!resolvedStorage) {
    return;
  }

  try {
    resolvedStorage.removeItem(FORCE_FRESH_ONBOARDING_STORAGE_KEY);
  } catch {
    // Ignore storage failures during startup.
  }
}

export function applyForceFreshOnboardingReset(args?: {
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
      resolvedStorage.removeItem(ONBOARDING_STEP_STORAGE_KEY);
      resolvedStorage.removeItem(LEGACY_ONBOARDING_STEP_STORAGE_KEY);
      resolvedStorage.removeItem(ONBOARDING_COMPLETE_STORAGE_KEY);
      resolvedStorage.setItem(FORCE_FRESH_ONBOARDING_STORAGE_KEY, "1");
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

export function installForceFreshOnboardingClientPatch(
  client: ClientLike,
  storage?: StorageLike | null,
): () => void {
  const patchableClient = client as PatchableClient;
  const existingPatch = patchableClient[PATCH_STATE];
  if (existingPatch) {
    return () => {};
  }

  const originalGetConfig = client.getConfig.bind(client);
  const originalGetOnboardingStatus = client.getOnboardingStatus.bind(client);
  const originalSubmitOnboarding = client.submitOnboarding.bind(client);

  patchableClient[PATCH_STATE] = {
    getConfig: client.getConfig,
    getOnboardingStatus: client.getOnboardingStatus,
    submitOnboarding: client.submitOnboarding,
  } satisfies PatchState;

  client.getConfig = async () => {
    if (isForceFreshOnboardingEnabled(storage)) {
      return {};
    }
    return originalGetConfig();
  };

  client.getOnboardingStatus = async () => {
    const status = (await originalGetOnboardingStatus()) as OnboardingStatus;
    if (!isForceFreshOnboardingEnabled(storage)) {
      return status;
    }
    return { ...status, complete: false };
  };

  client.submitOnboarding = async (...args) => {
    await originalSubmitOnboarding(...args);
    clearForceFreshOnboarding(storage);
  };

  return () => {
    const patchState = patchableClient[PATCH_STATE];
    if (!patchState) {
      return;
    }
    client.getConfig = patchState.getConfig;
    client.getOnboardingStatus = patchState.getOnboardingStatus;
    client.submitOnboarding = patchState.submitOnboarding;
    delete patchableClient[PATCH_STATE];
  };
}
