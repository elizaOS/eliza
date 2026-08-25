/**
 * Storage Bridge
 *
 * This module provides a bridge between the web UI's localStorage usage
 * and Capacitor's Preferences plugin for native platforms. On web, it
 * passes through to localStorage. On native, it uses Preferences for
 * more reliable persistence.
 *
 * The bridge works by intercepting localStorage calls via a proxy and
 * syncing with Capacitor Preferences on native platforms.
 */

import { Capacitor } from "@capacitor/core";
import { logger } from "@elizaos/logger";
import {
  registerStewardTokenPersistence,
  registerStewardTokenRemoval,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { MOBILE_RUNTIME_MODE_STORAGE_KEY } from "../first-run/mobile-runtime-mode";
import { runAsPrivilegedShell } from "../surface-realm-channel";
import {
  type DesktopSecureStoreKind,
  desktopSecureStoreDelete,
  desktopSecureStoreGet,
  desktopSecureStoreSet,
} from "./electrobun-rpc";
import { isElectrobunRuntime } from "./electrobun-runtime";

/**
 * Lazy-load the @capacitor/preferences module on demand. Keeping it out of the
 * static module graph means server consumers that pull in the @elizaos/ui barrel
 * (e.g. plugin-inbox in the Node agent image) don't crash resolving a
 * native-only, mobile-only devDependency. Only ever invoked behind an
 * `isNativePlatform()` guard.
 *
 * Returns the module namespace, NOT the bare `Preferences` plugin. The plugin is
 * a Capacitor proxy whose `.then` resolves to a function, which makes it
 * *thenable*: resolving any promise (an async return or a `.then` callback)
 * with the bare proxy triggers the Promise resolution procedure, which calls
 * `proxy.then(resolve, reject)`. On Android that throws
 * `"Preferences.then()" is not implemented` AND the proxy's `.then` ignores the
 * resolve/reject it was handed, so the adopting promise never settles —
 * `await loadPreferences()` would hang forever and block boot. The module
 * namespace has no `then` export, so it is safe to await; callers destructure
 * `{ Preferences }` and only ever resolve promises with method-call results.
 */
function loadPreferences() {
  return import("@capacitor/preferences");
}

function loadNativeSecureStore() {
  return import("@elizaos/capacitor-secure-store");
}

function isNativePlatform(): boolean {
  try {
    const platform = Capacitor.getPlatform();
    return (
      Capacitor.isNativePlatform() ||
      platform === "ios" ||
      platform === "android"
    );
  } catch {
    // error-policy:J4 no Capacitor bridge → web runtime; treat as non-native.
    return false;
  }
}

// Keys that should be synced to Capacitor Preferences.
// On iOS, WKWebView localStorage can be purged under memory pressure.
// These keys are critical for session restoration on mobile.
const SYNCED_KEYS = new Set([
  "eliza.control.settings.v1",
  "eliza.device.identity",
  // Native hosts intercept these through PROTECTED_STORAGE_KIND before this
  // set is consulted, so credentials never land in Preferences.
  "eliza.device.auth",
  STEWARD_TOKEN_KEY,
  "elizaos:active-server",
  "eliza:first-run-complete",
  "eliza:setup:step",
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  // `useAppLifecycleEvents` writes this on APP_PAUSE so the next
  // foreground can rehydrate the same conversation even after the
  // WKWebView localStorage was purged under memory pressure.
  "eliza:chat:activeConversationId",
  "eliza:ios-local-agent:conversations:v1",
  "eliza:ios-local-agent:active-model:v1",
  "eliza:ios-local-agent:assignments:v1",
  "eliza:ios-local-agent:browser-workspace:v1",
  "eliza:ios-local-agent:wallet-market-overview:v1",
  "eliza:ios-local-agent:eliza-1-bundles:v1",
  "eliza:ios-full-bun-smoke:request",
  "eliza:ios-full-bun-smoke:result",
  "eliza:ios-onboarding-smoke:request",
  "eliza:ios-onboarding-smoke:result",
  "eliza:ios-onboarding-relaunch-smoke:request",
  "eliza:ios-onboarding-relaunch-smoke:result",
  "eliza:ios-mixed-content-smoke:request",
  "eliza:ios-mixed-content-smoke:result",
  "eliza:ios-attachment-smoke:request",
  "eliza:ios-attachment-smoke:result",
  "eliza:ios-voice-selftest:request",
  "eliza:ios-voice-selftest:result",
  // Harness wallet for zero-interaction SIWE e2e (#13377): device harnesses
  // seed these via native Preferences before first launch; the install itself
  // is gated off store builds (platform/e2e-wallet.ts).
  "eliza:e2e-wallet:pk",
  "eliza:e2e-wallet:autologin",
]);

const PROTECTED_STORAGE_KIND = new Map<string, DesktopSecureStoreKind>([
  ["eliza.device.auth", "session.device_auth"],
  [STEWARD_TOKEN_KEY, "session.steward_token"],
  ["elizaos:active-server", "runtime.active_server"],
  ["elizaos:agent-profiles", "runtime.agent_profiles"],
]);

const protectedStorageCache = new Map<string, string>();
const protectedStorageMutationVersion = new Map<string, number>();
const protectedStorageMutationTail = new Map<string, Promise<void>>();

function markProtectedStorageMutation(key: string): number {
  const version = (protectedStorageMutationVersion.get(key) ?? 0) + 1;
  protectedStorageMutationVersion.set(key, version);
  return version;
}

/** Orders native mutations for one logical credential without coupling keys. */
function serializeProtectedStorageMutation<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor =
    protectedStorageMutationTail.get(key) ?? Promise.resolve();
  const result = predecessor.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  protectedStorageMutationTail.set(key, tail);
  void tail.then(() => {
    if (protectedStorageMutationTail.get(key) === tail) {
      protectedStorageMutationTail.delete(key);
    }
  });
  return result;
}

function serializedProtectedStoreSet(
  key: string,
  value: string,
): Promise<boolean> {
  return serializeProtectedStorageMutation(key, async () => {
    if (!(await protectedStoreSet(key, value))) return false;
    return (await protectedStoreGet(key)) === value;
  });
}

function serializedProtectedStoreDelete(key: string): Promise<void> {
  return serializeProtectedStorageMutation(key, () =>
    protectedStoreDelete(key),
  );
}

function isProtectedStorageHost(): boolean {
  return isNativePlatform() || isElectrobunRuntime();
}

async function protectedStoreGet(key: string): Promise<string | null> {
  const kind = PROTECTED_STORAGE_KIND.get(key);
  if (!kind) return null;
  if (isNativePlatform()) {
    const { ElizaSecureStore } = await loadNativeSecureStore();
    const result = await ElizaSecureStore.get({ key: kind });
    if (result.ok) {
      return typeof result.value === "string" ? result.value : null;
    }
    if (result.error === "not_found") return null;
    throw new Error("Native protected storage is unavailable");
  }
  if (isElectrobunRuntime()) {
    const result = await desktopSecureStoreGet(kind);
    if (result?.ok) {
      return typeof result.value === "string" ? result.value : null;
    }
    if (result?.reason === "not_found") return null;
    throw new Error("Desktop protected storage is unavailable");
  }
  return null;
}

async function protectedStoreSet(key: string, value: string): Promise<boolean> {
  const kind = PROTECTED_STORAGE_KIND.get(key);
  if (!kind) return false;
  if (isNativePlatform()) {
    const { ElizaSecureStore } = await loadNativeSecureStore();
    return (await ElizaSecureStore.set({ key: kind, value })).ok;
  }
  if (isElectrobunRuntime()) {
    return (await desktopSecureStoreSet(kind, value))?.ok === true;
  }
  return false;
}

async function protectedStoreDelete(key: string): Promise<void> {
  const kind = PROTECTED_STORAGE_KIND.get(key);
  if (!kind) {
    throw new Error("Protected storage kind is not registered");
  }
  if (isNativePlatform()) {
    const { ElizaSecureStore } = await loadNativeSecureStore();
    const result = await ElizaSecureStore.remove({ key: kind });
    if (result.ok || result.error === "not_found") return;
    throw new Error("Native protected storage rejected deletion");
  }
  if (isElectrobunRuntime()) {
    const result = await desktopSecureStoreDelete(kind);
    if (result?.ok || result?.reason === "not_found") return;
    throw new Error("Desktop protected storage rejected deletion");
  }
  throw new Error("Protected storage is unavailable");
}

// In-memory cache of values from Preferences (for native)
const preferencesCache = new Map<string, string>();

// Flag to track if initial sync has completed
let initialized = false;
let storageProxyInstalled = false;

interface NativeStorageMethods {
  storage: Storage;
  setItem: (key: string, value: string) => void;
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  prototypeSetItem: Storage["setItem"];
  prototypeGetItem: Storage["getItem"];
  prototypeRemoveItem: Storage["removeItem"];
}

let nativeLocalStorageMethods: NativeStorageMethods | null = null;

function getNativeLocalStorageMethods(): NativeStorageMethods {
  if (nativeLocalStorageMethods) return nativeLocalStorageMethods;
  const storage = window.localStorage;
  const prototype = Object.getPrototypeOf(storage) as Storage;
  const prototypeSetItem = prototype.setItem;
  const prototypeGetItem = prototype.getItem;
  const prototypeRemoveItem = prototype.removeItem;
  nativeLocalStorageMethods = {
    storage,
    // Bind the functions the instance itself resolves rather than the
    // prototype slots. Hosts that hand out `localStorage` through a proxy
    // (jsdom does) reject a prototype method invoked with the proxy as `this`
    // on their branded internal-slot check; the instance-resolved function
    // works on both a proxied and a plain Storage object.
    setItem: storage.setItem.bind(storage),
    getItem: storage.getItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
    prototypeSetItem,
    prototypeGetItem,
    prototypeRemoveItem,
  };
  return nativeLocalStorageMethods;
}

const PREFERENCE_READ_TIMEOUT_MS = 1_500;
// Warm-up probe before hydration: retry a few times so a cold native bridge
// doesn't drop critical synced keys (first-run-complete, active-server, …).
const PREFERENCE_HYDRATION_ATTEMPTS = 6;
const PREFERENCE_HYDRATION_RETRY_MS = 350;

/**
 * Resolve `true` as soon as the native Preferences plugin answers a call (even
 * with a null value), `false` if it times out (still cold). Used to warm up the
 * bridge before hydration so a cold plugin doesn't silently drop synced keys.
 */
async function preferencesResponded(): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<false>((resolve) => {
      timeoutId = setTimeout(() => resolve(false), PREFERENCE_READ_TIMEOUT_MS);
    });
    const { Preferences } = await loadPreferences();
    const probe = Preferences.get({ key: "eliza:first-run-complete" }).then(
      () => true as const,
    );
    return await Promise.race([probe, timeout]);
  } catch {
    // error-policy:J4 probe contract is "did the plugin answer?"; a thrown
    // read means it did not (still cold) — the caller retries.
    return false;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

async function readPreferenceWithTimeout(key: string): Promise<string | null> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), PREFERENCE_READ_TIMEOUT_MS);
    });
    const { Preferences } = await loadPreferences();
    const result = await Promise.race([Preferences.get({ key }), timeout]);
    return result?.value ?? null;
  } catch {
    // error-policy:J4 hydration read is best-effort; a failed/timed-out read
    // skips this key for the pass. The warm-up probe gates `initialized`, so a
    // cold bridge re-hydrates rather than permanently dropping the key.
    return null;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

/**
 * Initialize the storage bridge
 *
 * On native platforms, this loads values from Capacitor Preferences
 * into the in-memory cache and optionally syncs them to localStorage.
 */
export async function initializeStorageBridge(): Promise<void> {
  if (initialized) {
    return;
  }

  if (!isNativePlatform() && !isElectrobunRuntime()) {
    return;
  }

  const { getItem: originalGetItem, removeItem: originalRemoveItem } =
    getNativeLocalStorageMethods();

  // Install the proxy FIRST, before any of the awaited native round trips
  // below. Hydration and protected-credential migration each await the real
  // Preferences/secure-store bridge, which can take several retries to warm
  // up; every await below is a window where a concurrent `localStorage` call
  // on a protected key (e.g. a login flow racing this init) would otherwise
  // hit the raw, unpatched Storage prototype — reading a still-present legacy
  // plaintext value straight off disk, or writing a fresh credential in
  // plaintext instead of into the secure store. Installing the proxy up front
  // means every protected-key access, including ones that race this
  // function, is intercepted from the first possible moment: reads are
  // gated on `protectedStorageCache` (empty until migration populates it,
  // so they return null rather than leaking the legacy plaintext) and writes
  // go straight to the secure store instead of `originalSetItem`. The
  // migration loop below reads/removes the legacy value through the
  // `originalGetItem`/`originalRemoveItem` closures captured above, which
  // stay bound to the raw prototype regardless of when the proxy patches it,
  // so migration itself is unaffected by moving this earlier.
  setupStorageProxy();

  // The Capacitor Preferences plugin is frequently not yet responsive on the
  // first read during very early WebView startup (the bridge is still wiring
  // up), so a single best-effort pass loses critical session/first-run state —
  // e.g. `eliza:first-run-complete` fails to hydrate and the user is bounced
  // back into onboarding even though native Preferences has it. Probe one key
  // with a few short retries until the plugin answers, then hydrate. The probe
  // can't distinguish "plugin cold" from "key genuinely unset", so it is capped
  // and never blocks first paint for more than a moment.
  let pluginResponded = isElectrobunRuntime();
  if (isNativePlatform()) {
    for (
      let attempt = 0;
      attempt < PREFERENCE_HYDRATION_ATTEMPTS;
      attempt += 1
    ) {
      if (await preferencesResponded()) {
        pluginResponded = true;
        break;
      }
      if (attempt < PREFERENCE_HYDRATION_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, PREFERENCE_HYDRATION_RETRY_MS),
        );
      }
    }
  }

  // Load synced keys from Preferences into cache. Hydration stays best-effort so
  // a single stale preference read cannot block first paint.
  const entries = isNativePlatform()
    ? await Promise.all(
        Array.from(
          isProtectedStorageHost()
            ? [...SYNCED_KEYS].filter((key) => !PROTECTED_STORAGE_KIND.has(key))
            : SYNCED_KEYS,
          async (key) => [key, await readPreferenceWithTimeout(key)] as const,
        ),
      )
    : [];
  for (const [key, value] of entries) {
    if (value === null) continue;
    preferencesCache.set(key, value);
    // Also set in localStorage for immediate availability. Privileged: the
    // synced keys are shell-reserved and re-hydration can run after mount
    // (cold-plugin retry), i.e. while a surface scope has the raw guard armed.
    try {
      runAsPrivilegedShell(() => window.localStorage.setItem(key, value));
    } catch {
      // error-policy:J4 localStorage mirror is best-effort; the authoritative
      // copy lives in `preferencesCache` (set above). A quota/private-mode
      // write failure must not abort hydration of the remaining keys.
    }
  }

  // Migrate legacy plaintext credentials only after a write + read-back match.
  // On a failed store call the old value stays in place for recovery, while all
  // new writes below remain memory-only instead of silently reintroducing
  // plaintext persistence.
  let protectedStoreResponded = true;
  if (isProtectedStorageHost()) {
    for (const key of PROTECTED_STORAGE_KIND.keys()) {
      try {
        const protectedValue = await protectedStoreGet(key);
        if (protectedValue !== null) {
          protectedStorageCache.set(key, protectedValue);
          originalRemoveItem(key);
          if (isNativePlatform()) {
            const { Preferences } = await loadPreferences();
            await Preferences.remove({ key });
          }
          continue;
        }

        const preferenceValue = isNativePlatform()
          ? await readPreferenceWithTimeout(key)
          : null;
        const legacyValue = preferenceValue ?? originalGetItem(key);
        if (legacyValue === null) continue;

        protectedStorageCache.set(key, legacyValue);
        const stored = await protectedStoreSet(key, legacyValue);
        const verified = stored ? await protectedStoreGet(key) : null;
        if (verified !== legacyValue) {
          protectedStoreResponded = false;
          logger.error(
            { key },
            "[StorageBridge] protected-storage migration did not verify",
          );
          continue;
        }
        originalRemoveItem(key);
        if (isNativePlatform()) {
          const { Preferences } = await loadPreferences();
          await Preferences.remove({ key });
        }
      } catch (err) {
        protectedStoreResponded = false;
        logger.error(
          { err, key },
          "[StorageBridge] protected-storage hydration failed",
        );
      }
    }
  }

  // Only consider the bridge initialized once the native plugin has actually
  // answered. If it never warmed up, leave `initialized` false so a later call
  // (e.g. from initializePlatform after more of the bridge has wired up)
  // re-hydrates instead of permanently dropping critical synced keys —
  // first-run-complete, active-server, the smoke request — which otherwise
  // strands the user in onboarding or silently skips the QA smoke.
  if (pluginResponded && protectedStoreResponded) {
    initialized = true;
  }
}

/**
 * Set up a proxy to intercept localStorage operations
 */
function setupStorageProxy(): void {
  if (storageProxyInstalled) {
    return;
  }

  if (!isNativePlatform() && !isElectrobunRuntime()) {
    return;
  }

  const nativeStorage = getNativeLocalStorageMethods();
  const {
    setItem: originalSetItem,
    getItem: originalGetItem,
    removeItem: originalRemoveItem,
  } = nativeStorage;

  // Patch the shared Storage prototype with a localStorage-only branch instead
  // of assigning named properties on the Storage instance. Web Storage objects
  // have exotic named-property behavior, so a plain `localStorage.setItem =
  // fn` (and, in WebKit-style implementations, even an own descriptor) can
  // become a persisted key or be ignored. sessionStorage and any other Storage
  // object continue through the captured native prototype methods unchanged.
  const localStorageInstance = nativeStorage.storage;
  const storagePrototype = Object.getPrototypeOf(
    localStorageInstance,
  ) as Storage;
  const { prototypeSetItem, prototypeGetItem, prototypeRemoveItem } =
    nativeStorage;
  const secureSetItem = (key: string, value: string): void => {
    if (isProtectedStorageHost() && PROTECTED_STORAGE_KIND.has(key)) {
      // Web Storage is synchronous, so this legacy-compatible surface remains
      // explicitly optimistic. Security-critical producers use the awaited
      // setStorageValue registration below and are published only after
      // protected-store write plus exact readback succeeds.
      markProtectedStorageMutation(key);
      protectedStorageCache.set(key, value);
      originalRemoveItem(key);
      setTimeout(() => {
        serializedProtectedStoreSet(key, value)
          .then((stored) => {
            if (!stored) {
              logger.error(
                { key },
                "[StorageBridge] secure-store rejected protected write",
              );
            }
          })
          .catch((err) => {
            logger.error(
              { err, key },
              "[StorageBridge] failed to persist protected key",
            );
          });
      }, 0);
      return;
    }
    // Always set in localStorage first
    originalSetItem(key, value);

    // If it's a synced key, also persist to Preferences
    if (SYNCED_KEYS.has(key)) {
      preferencesCache.set(key, value);
      // Fire and forget on a later task. Some native bridge calls can stall
      // during early WebView startup; localStorage writes must stay sync-fast.
      setTimeout(() => {
        loadPreferences()
          .then(({ Preferences }) => Preferences.set({ key, value }))
          .catch((err) => {
            // A dropped synced write silently diverges a critical key
            // (session/auth/first-run) across restarts — surface it instead
            // of swallowing. Fire-and-forget scheduling stays; the value is
            // already in `preferencesCache` for this session.
            logger.error(
              { err, key },
              "[StorageBridge] failed to sync key to Preferences",
            );
          });
      }, 0);
    }
  };

  // Override getItem
  const secureGetItem = (key: string): string | null => {
    if (isProtectedStorageHost() && PROTECTED_STORAGE_KIND.has(key)) {
      return protectedStorageCache.get(key) ?? null;
    }
    // For synced keys, prefer the cache (which was loaded from Preferences)
    if (SYNCED_KEYS.has(key) && preferencesCache.has(key)) {
      return preferencesCache.get(key) ?? null;
    }
    return originalGetItem(key);
  };

  // Override removeItem
  const secureRemoveItem = (key: string): void => {
    if (isProtectedStorageHost() && PROTECTED_STORAGE_KIND.has(key)) {
      const removalVersion = markProtectedStorageMutation(key);
      setTimeout(() => {
        serializedProtectedStoreDelete(key)
          .then(() => {
            if (protectedStorageMutationVersion.get(key) === removalVersion) {
              protectedStorageCache.delete(key);
              originalRemoveItem(key);
            }
          })
          .catch((err) => {
            // error-policy:J4 a synchronous Web Storage call cannot surface an
            // asynchronous native rejection. Retain the cached credential so
            // the current session does not claim a deletion that did not occur.
            logger.error(
              { err, key },
              "[StorageBridge] failed to remove protected key",
            );
          });
      }, 0);
      return;
    }
    originalRemoveItem(key);

    if (SYNCED_KEYS.has(key)) {
      preferencesCache.delete(key);
      setTimeout(() => {
        loadPreferences()
          .then(({ Preferences }) => Preferences.remove({ key }))
          .catch((err) => {
            // A dropped synced removal leaves a stale key in Preferences that
            // out-of-sync-hydrates on the next restart — surface it instead of
            // swallowing. The in-session cache was already cleared above.
            logger.error(
              { err, key },
              "[StorageBridge] failed to remove key from Preferences",
            );
          });
      }, 0);
    }
  };

  function storageBridgeSetItem(this: Storage, key: string, value: string) {
    if (this === localStorageInstance) return secureSetItem(key, value);
    return prototypeSetItem.call(this, key, value);
  }
  function storageBridgeGetItem(this: Storage, key: string) {
    if (this === localStorageInstance) return secureGetItem(key);
    return prototypeGetItem.call(this, key);
  }
  function storageBridgeRemoveItem(this: Storage, key: string) {
    if (this === localStorageInstance) return secureRemoveItem(key);
    return prototypeRemoveItem.call(this, key);
  }

  Object.defineProperties(storagePrototype, {
    setItem: {
      configurable: true,
      writable: true,
      value: storageBridgeSetItem,
    },
    getItem: {
      configurable: true,
      writable: true,
      value: storageBridgeGetItem,
    },
    removeItem: {
      configurable: true,
      writable: true,
      value: storageBridgeRemoveItem,
    },
  });

  // A host may hand out `localStorage` through a wrapper that does not resolve
  // method lookups through the prototype patched above (jsdom's proxy does
  // not). Interception is a security boundary, so verify it rather than assume
  // it, and install the same branch directly on the instance when the
  // prototype patch is not observable there. `defineProperty` is used instead
  // of plain assignment because a Web Storage `[[Set]]` on an unknown name is
  // a named-property write that would persist a bogus "setItem" entry.
  if (localStorageInstance.getItem !== storageBridgeGetItem) {
    Object.defineProperties(localStorageInstance, {
      setItem: {
        configurable: true,
        writable: true,
        value: secureSetItem,
      },
      getItem: {
        configurable: true,
        writable: true,
        value: secureGetItem,
      },
      removeItem: {
        configurable: true,
        writable: true,
        value: secureRemoveItem,
      },
    });
  }
  storageProxyInstalled = true;
}

/**
 * Get a value from storage (works on both native and web)
 */
export async function getStorageValue(key: string): Promise<string | null> {
  if (isProtectedStorageHost() && PROTECTED_STORAGE_KIND.has(key)) {
    const value = await protectedStoreGet(key);
    if (value !== null) protectedStorageCache.set(key, value);
    return value ?? protectedStorageCache.get(key) ?? null;
  }
  if (isNativePlatform() && SYNCED_KEYS.has(key)) {
    const { Preferences } = await loadPreferences();
    const result = await Preferences.get({ key });
    return result.value;
  }
  return window.localStorage.getItem(key);
}

/**
 * Set a value in storage (works on both native and web)
 */
export async function setStorageValue(
  key: string,
  value: string,
): Promise<void> {
  if (isProtectedStorageHost() && PROTECTED_STORAGE_KIND.has(key)) {
    const mutationVersion = markProtectedStorageMutation(key);
    if (!(await serializedProtectedStoreSet(key, value))) {
      throw new Error(`Protected storage rejected write for ${key}`);
    }
    if (protectedStorageMutationVersion.get(key) === mutationVersion) {
      protectedStorageCache.set(key, value);
    }
    return;
  }
  // Privileged: this is the shell-side persistence helper (session/auth/
  // first-run keys); the view-facing path is the scoped override in
  // DynamicViewLoader's bridge compat, not this function.
  runAsPrivilegedShell(() => window.localStorage.setItem(key, value));

  if (isNativePlatform() && SYNCED_KEYS.has(key)) {
    const { Preferences } = await loadPreferences();
    await Preferences.set({ key, value });
  }
}

/**
 * Remove a value from storage (works on both native and web)
 */
export async function removeStorageValue(key: string): Promise<void> {
  if (isProtectedStorageHost() && PROTECTED_STORAGE_KIND.has(key)) {
    const removalVersion = markProtectedStorageMutation(key);
    await serializedProtectedStoreDelete(key);
    if (protectedStorageMutationVersion.get(key) === removalVersion) {
      protectedStorageCache.delete(key);
    }
    return;
  }
  runAsPrivilegedShell(() => window.localStorage.removeItem(key));

  if (isNativePlatform() && SYNCED_KEYS.has(key)) {
    const { Preferences } = await loadPreferences();
    await Preferences.remove({ key });
  }
}

/**
 * Register additional keys to be synced to Preferences
 */
export function registerSyncedKey(key: string): void {
  SYNCED_KEYS.add(key);
}

/**
 * Check if storage bridge is initialized
 */
export function isStorageBridgeInitialized(): boolean {
  return initialized;
}

registerStewardTokenRemoval(() => removeStorageValue(STEWARD_TOKEN_KEY));
registerStewardTokenPersistence((token) =>
  setStorageValue(STEWARD_TOKEN_KEY, token),
);
