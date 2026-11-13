/**
 * Coordinates the onboarding soft-ask permission sequence across web, desktop,
 * and native registries without prompting the OS until the user opts in.
 */

import type {
  IPermissionsRegistry,
  PermissionId,
  PermissionStatus,
} from "@elizaos/core/protocol";
import * as React from "react";
import { client } from "../../api/client";
import { checkDesktopPermissionFresh } from "../../platform/desktop-permissions-client";
import { isDesktopPlatform, isNative } from "../../platform/init";
import {
  createMobileSignalsPermissionsRegistry,
  openMobilePermissionSettings,
} from "../../platform/mobile-permissions-client";
import { createClientPermissionsRegistry } from "../composites/chat/permission-card.helpers";
import { useNativePermissionHost } from "./native-permission-host";
import {
  type WalkthroughMemoryStore,
  walkthroughAttemptKey,
  walkthroughRequestRoute,
} from "./permission-walkthrough";
/**
 * Sequencing controller for the onboarding permission-priming modal.
 *
 * Generalizes the single-permission `useMicrophonePermission` to an ordered set
 * of PermissionIds and walks them one card at a time. It reuses the exact same
 * platform routing every other permission surface uses — the native
 * MobileSignals registry on iOS/Android, the (desktop-patched or web) client
 * registry elsewhere — so there is no second permission client.
 *
 * Soft-ask: the OS dialog is only fired from `request()` (the card's "Enable"
 * tap). Nothing here prompts on mount — mount only *checks* current status so
 * already-granted permissions are skipped and never re-prompted.
 *
 * Permission request failures stay distinct from user denials so recovery copy
 * never blames the user for a broken native bridge or app identity.
 */
export type PrimingItemStatus = PermissionStatus | "unknown";
export interface PrimingItem {
  id: PermissionId;
  status: PrimingItemStatus;
  /** Current platform scope or limitation, never inferred from walkthrough progress. */
  reason?: string;
  /** Whether the OS request can still be (re)fired; false once hard-denied. */
  canRequest: boolean;
  /** True while this item's OS request is in flight. */
  requesting: boolean;
  /** The platform request failed before the OS recorded a user decision. */
  requestError: boolean;
  /** The authoritative post-Settings status refresh failed. */
  recheckError: boolean;
  /**
   * This walkthrough already showed the OS prompt (in this run or before a restart) and access
   * is still missing, so the card routes to system settings instead of prompting again.
   */
  promptShown?: boolean;
  /**
   * True once the user is done with this card — granted, or explicitly skipped.
   * A denied item is NOT resolved: it stays active so the recovery affordance
   * shows and the user can retry, open settings, or skip.
   */
  resolved: boolean;
}
export interface PermissionPrimingController {
  /** Promptable items in order (already-granted/N-A ids are excluded). */
  items: PrimingItem[];
  /** Index into `items` of the first unresolved card, or `items.length`. */
  activeIndex: number;
  /** The card currently shown, or null when the sequence is complete. */
  active: PrimingItem | null;
  /** 1-based position of the active card for a "x of N" indicator. */
  currentStep: number;
  /** Total number of cards in the sequence. */
  totalSteps: number;
  /** True once the initial status check has completed. */
  ready: boolean;
  /** True when every item is resolved (or there were none). */
  done: boolean;
  /** Fire the OS request for `id` (the "Enable" tap). */
  request: (id: PermissionId) => Promise<void>;
  /** Skip `id` without touching the OS (soft-deny; capability preserved). */
  skip: (id: PermissionId) => void;
  /** Open OS settings so a hard-denied permission can be granted manually. */
  openSettings: (id: PermissionId) => Promise<void>;
  /** Re-check `id`'s status (e.g. after returning from OS settings). */
  recheck: (id: PermissionId) => Promise<void>;
  /** Skip every remaining card at once ("Not now" for the whole flow). */
  skipAll: () => void;
}
const PRIMING_FEATURE = { app: "onboarding", action: "permission-priming" };
const PRIMING_REASON =
  "Requested during onboarding so the assistant is ready to use this feature.";
/** Statuses that need no action, so their card is never shown. */
function isSatisfied(status: PrimingItemStatus): boolean {
  return (
    status === "granted" ||
    status === "not-applicable" ||
    status === "restricted"
  );
}
function selectRegistry(): IPermissionsRegistry {
  return isNative && !isDesktopPlatform()
    ? createMobileSignalsPermissionsRegistry(undefined, client)
    : createClientPermissionsRegistry(client);
}
async function openSettingsFor(id: PermissionId): Promise<void> {
  if (isNative && !isDesktopPlatform()) {
    await openMobilePermissionSettings(id);
    return;
  }
  await client.openPermissionSettings(id);
}
export interface PermissionPrimingOptions {
  /**
   * Walkthrough memory: records each OS prompt this walkthrough fires so it is never fired again
   * (a later tap opens system settings), and records "Skip for now". Omitted, every tap may prompt.
   */
  memory?: WalkthroughMemoryStore;
}
export function usePermissionPriming(
  ids: readonly PermissionId[],
  options: PermissionPrimingOptions = {},
): PermissionPrimingController {
  const host = useNativePermissionHost();
  const memory = options.memory ?? host?.memory;
  const defaultRegistry = React.useMemo(selectRegistry, []);
  const registry = host?.registry ?? defaultRegistry;
  const idsKey = ids.join(",");
  const [items, setItems] = React.useState<PrimingItem[]>([]);
  const [ready, setReady] = React.useState(false);
  const requestingRef = React.useRef<Map<PermissionId, symbol>>(new Map());
  const generation = React.useRef(0);
  // Mount check: probe each id WITHOUT prompting, then keep only the ones that
  // still need action. Already-granted / not-applicable / restricted ids are
  // dropped so no card is shown for them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `idsKey` is the stable string identity of `ids`; depending on the `ids` array itself would re-run the OS status check on every render for callers that pass a fresh array literal.
  React.useEffect(() => {
    let cancelled = false;
    ++generation.current;
    requestingRef.current = new Map();
    setReady(false);
    setItems([]);
    void (async () => {
      const checked = await Promise.all(
        ids.map(async (id) => {
          try {
            const state = await registry.check(id);
            return {
              id,
              status: state.status,
              canRequest: state.canRequest,
              reason: state.reason,
            };
          } catch {
            // Treat an unknowable status as promptable — better to offer the
            // card than to silently skip a real permission.
            return {
              id,
              status: "unknown" as PrimingItemStatus,
              canRequest: true,
            };
          }
        }),
      );
      if (cancelled) return;
      setItems(
        checked
          .filter(
            (entry) =>
              !isSatisfied(entry.status) &&
              !memory?.read().reviewed?.[walkthroughAttemptKey(entry.id)],
          )
          .map((entry) => {
            const promptShown =
              walkthroughRequestRoute(memory, entry.id) === "settings";
            return {
              id: entry.id,
              status: entry.status,
              reason: entry.reason,
              canRequest: entry.canRequest && !promptShown,
              promptShown,
              requesting: false,
              requestError: false,
              recheckError: false,
              resolved: false,
            };
          }),
      );
      setReady(true);
    })();
    return () => {
      cancelled = true;
      ++generation.current;
      requestingRef.current.clear();
    };
    // idsKey captures the id list identity; registry is stable (useMemo []).
  }, [idsKey, registry, memory]);
  const patch = React.useCallback(
    (id: PermissionId, next: Partial<PrimingItem>) => {
      setItems((current) =>
        current.map((item) => (item.id === id ? { ...item, ...next } : item)),
      );
    },
    [],
  );
  const request = React.useCallback(
    async (id: PermissionId) => {
      if (!items.some((item) => item.id === id && !item.resolved)) return;
      if (requestingRef.current.has(id)) return;
      if (walkthroughRequestRoute(memory, id) === "settings") {
        // The prompt was already shown: never fire it twice. The card offers settings instead.
        patch(id, { canRequest: false, promptShown: true });
        return;
      }
      const owner = generation.current;
      const ticket = Symbol(id);
      requestingRef.current.set(id, ticket);
      const current = () =>
        generation.current === owner &&
        requestingRef.current.get(id) === ticket;
      patch(id, {
        requesting: true,
        requestError: false,
        recheckError: false,
      });
      try {
        const state = await registry.request(id, {
          reason: PRIMING_REASON,
          feature: PRIMING_FEATURE,
        });
        // The OS answered, so its prompt was shown: record it so this walkthrough never fires it
        // again, here or after a restart. A failed request (below) records nothing and may retry.
        memory?.write({ attempted: { [walkthroughAttemptKey(id)]: true } });
        if (!current()) return;
        patch(id, {
          status: state.status,
          reason: state.reason,
          canRequest: state.canRequest && !memory,
          promptShown: !!memory && state.status !== "granted",
          requesting: false,
          requestError: false,
          recheckError: false,
          // Granting resolves the card; a denial keeps it active for recovery.
          resolved: state.status === "granted" && !state.reason,
        });
      } catch {
        // error-policy:J4 native/transport failures remain visibly different from
        // a real OS denial and keep an explicit retry path.
        if (current())
          patch(id, {
            status: "unknown",
            canRequest: true,
            requesting: false,
            requestError: true,
            recheckError: false,
          });
      } finally {
        if (requestingRef.current.get(id) === ticket)
          requestingRef.current.delete(id);
      }
    },
    [items, patch, registry, memory],
  );
  const skip = React.useCallback(
    (id: PermissionId) => {
      requestingRef.current.delete(id);
      memory?.write({
        reviewed: {
          ...memory.read().reviewed,
          [walkthroughAttemptKey(id)]: true,
        },
      });
      patch(id, { resolved: true });
    },
    [memory, patch],
  );
  const openSettings = React.useCallback(
    async (id: PermissionId) => {
      if (host) {
        if (!(await host.registry.openSettings(id)))
          throw Error("Permission settings did not open");
      } else await openSettingsFor(id);
    },
    [host],
  );
  const recheck = React.useCallback(
    async (id: PermissionId) => {
      const owner = generation.current;
      try {
        // Returning from System Settings must bypass PermissionManager's
        // short-lived cache for this exact permission; refreshing every prober
        // would couple recovery to unrelated OS integrations.
        const state =
          !host && isDesktopPlatform()
            ? await checkDesktopPermissionFresh(id)
            : await registry.check(id);
        if (generation.current !== owner) return;
        patch(id, {
          status: state.status,
          reason: state.reason,
          canRequest: state.canRequest,
          requestError: false,
          recheckError: false,
          resolved: state.status === "granted" && !state.reason,
        });
      } catch {
        // error-policy:J4 an authoritative refresh failure stays visible so
        // the recovery control never appears to do nothing.
        if (generation.current === owner) patch(id, { recheckError: true });
      }
    },
    [host, patch, registry],
  );
  const skipAll = React.useCallback(() => {
    requestingRef.current.clear();
    memory?.write({ dismissed: true });
    setItems((current) => current.map((item) => ({ ...item, resolved: true })));
  }, [memory]);
  const activeIndex = items.findIndex((item) => !item.resolved);
  const active = activeIndex === -1 ? null : items[activeIndex];
  const done = ready && active === null;
  return {
    items,
    activeIndex: activeIndex === -1 ? items.length : activeIndex,
    active,
    currentStep: activeIndex === -1 ? items.length : activeIndex + 1,
    totalSteps: items.length,
    ready,
    done,
    request,
    skip,
    openSettings,
    recheck,
    skipAll,
  };
}
