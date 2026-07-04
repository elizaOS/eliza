/**
 * Coordinates the onboarding soft-ask permission sequence across web, desktop,
 * and native registries without prompting the OS until the user opts in.
 */
import type {
  IPermissionsRegistry,
  PermissionId,
  PermissionStatus,
} from "@elizaos/shared/contracts/permissions";
import * as React from "react";
import { client } from "../../api/client";
import { isDesktopPlatform, isNative } from "../../platform";
import {
  createMobileSignalsPermissionsRegistry,
  openMobilePermissionSettings,
} from "../../platform/mobile-permissions-client";
import { createClientPermissionsRegistry } from "../composites/chat/permission-card.helpers";

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
 * Like `useMicrophonePermission`, no method throws — every path resolves to a
 * concrete, renderable state.
 */

export type PrimingItemStatus = PermissionStatus | "unknown";

export interface PrimingItem {
  id: PermissionId;
  status: PrimingItemStatus;
  /** Whether the OS request can still be (re)fired; false once hard-denied. */
  canRequest: boolean;
  /** True while this item's OS request is in flight. */
  requesting: boolean;
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

export function usePermissionPriming(
  ids: readonly PermissionId[],
): PermissionPrimingController {
  const registry = React.useMemo(selectRegistry, []);
  const idsKey = ids.join(",");

  const [items, setItems] = React.useState<PrimingItem[]>([]);
  const [ready, setReady] = React.useState(false);
  const requestingRef = React.useRef<Set<PermissionId>>(new Set());

  // Mount check: probe each id WITHOUT prompting, then keep only the ones that
  // still need action. Already-granted / not-applicable / restricted ids are
  // dropped so no card is shown for them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `idsKey` is the stable string identity of `ids`; depending on the `ids` array itself would re-run the OS status check on every render for callers that pass a fresh array literal.
  React.useEffect(() => {
    let cancelled = false;
    requestingRef.current = new Set();
    setReady(false);
    setItems([]);
    void (async () => {
      const checked = await Promise.all(
        ids.map(async (id) => {
          try {
            const state = await registry.check(id);
            return { id, status: state.status, canRequest: state.canRequest };
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
          .filter((entry) => !isSatisfied(entry.status))
          .map((entry) => ({
            id: entry.id,
            status: entry.status,
            canRequest: entry.canRequest,
            requesting: false,
            resolved: false,
          })),
      );
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // idsKey captures the id list identity; registry is stable (useMemo []).
  }, [idsKey, registry]);

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
      if (requestingRef.current.has(id)) return;
      requestingRef.current.add(id);
      patch(id, { requesting: true });
      try {
        const state = await registry.request(id, {
          reason: PRIMING_REASON,
          feature: PRIMING_FEATURE,
        });
        patch(id, {
          status: state.status,
          canRequest: state.canRequest,
          requesting: false,
          // Granting resolves the card; a denial keeps it active for recovery.
          resolved: state.status === "granted",
        });
      } catch {
        // A thrown request is itself a soft failure — surface it as denied so
        // the recovery affordance shows rather than a dead card.
        patch(id, { status: "denied", canRequest: false, requesting: false });
      } finally {
        requestingRef.current.delete(id);
      }
    },
    [patch, registry],
  );

  const skip = React.useCallback(
    (id: PermissionId) => {
      patch(id, { resolved: true });
    },
    [patch],
  );

  const openSettings = React.useCallback(async (id: PermissionId) => {
    try {
      await openSettingsFor(id);
    } catch {
      // Opening OS settings is best-effort; a failure must not wedge the flow.
    }
  }, []);

  const recheck = React.useCallback(
    async (id: PermissionId) => {
      try {
        const state = await registry.check(id);
        patch(id, {
          status: state.status,
          canRequest: state.canRequest,
          resolved: state.status === "granted",
        });
      } catch {
        // Leave the current state untouched if the re-check can't resolve.
      }
    },
    [patch, registry],
  );

  const skipAll = React.useCallback(() => {
    setItems((current) => current.map((item) => ({ ...item, resolved: true })));
  }, []);

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
