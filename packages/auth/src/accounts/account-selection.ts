import type {
  LinkedAccountConfig,
  LinkedAccountProviderId,
} from "@elizaos/contracts";
import type { DirectAccountProvider } from "../auth/types.js";

export type Strategy =
  | "priority"
  | "round-robin"
  | "least-used"
  | "quota-aware"
  | "reset-soonest"
  | "drain-soonest-reset";
export type PoolProviderId = LinkedAccountProviderId;

interface AccountPoolSelectionRoute {
  backend?: string;
  accountId?: string;
  accountIds?: string[];
  strategy?: string;
}
export interface AccountPoolSelectionConfig {
  accountStrategies?: Partial<Record<PoolProviderId, unknown>>;
  serviceRouting?: {
    llmText?: AccountPoolSelectionRoute;
  } | null;
}

export const DIRECT_PROVIDER_BY_BACKEND: Readonly<
  Record<string, DirectAccountProvider>
> = {
  anthropic: "anthropic-api",
  openai: "openai-api",
  deepseek: "deepseek-api",
  zai: "zai-api",
  moonshot: "moonshot-api",
  openrouter: "openrouter-api",
  // First-run canonicalizes xAI to `grok` and persists that backend id in
  // `serviceRouting.llmText`; `xai` stays as the compatibility alias.
  grok: "xai-api",
  xai: "xai-api",
};

export function isAccountExpired(
  account: LinkedAccountConfig,
  now: number = Date.now(),
): boolean {
  return (
    typeof account.subscriptionEndsAt === "number" &&
    account.subscriptionEndsAt <= now
  );
}

/**
 * Health half of the eligibility gate, shared with the coding-agent bridge's
 * `describe()` so availability reporting can never disagree with what
 * `select()` would actually serve: `ok` is selectable, and a rate-limited
 * account is selectable again once its `healthDetail.until` reset has elapsed
 * (`invalid` / `needs-reauth` never re-admit on their own). Counting only
 * `health === "ok"` here used to report `healthy: 0` for a pool whose
 * rate-limit window had already elapsed — making the orchestrator's failover
 * gate refuse a respawn that `select()` would have served.
 */
export function isAccountSelectableNow(
  account: LinkedAccountConfig,
  now: number = Date.now(),
): boolean {
  if (isAccountExpired(account, now)) return false;
  if (account.health === "ok") return true;
  return (
    account.health === "rate-limited" &&
    typeof account.healthDetail?.until === "number" &&
    account.healthDetail.until < now
  );
}

let defaultSelectionConfig: AccountPoolSelectionConfig = {};
function normalizeStrategy(value: unknown): Strategy | undefined {
  return value === "priority" ||
    value === "round-robin" ||
    value === "least-used" ||
    value === "quota-aware" ||
    value === "reset-soonest" ||
    value === "drain-soonest-reset"
    ? value
    : undefined;
}
function normalizeAccountIdsFromRoute(
  route: AccountPoolSelectionRoute | undefined,
): string[] | undefined {
  if (!route) return undefined;
  const fromList = Array.isArray(route.accountIds)
    ? route.accountIds
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter(Boolean)
    : [];
  const single =
    typeof route.accountId === "string" && route.accountId.trim()
      ? [route.accountId.trim()]
      : [];
  const ids = fromList.length > 0 ? fromList : single;
  return ids.length > 0 ? ids : undefined;
}
function routeTargetsProvider(
  route: AccountPoolSelectionRoute | undefined,
  providerId: PoolProviderId,
): boolean {
  if (!route?.backend) return false;
  const directProvider = DIRECT_PROVIDER_BY_BACKEND[route.backend];
  if (directProvider === providerId) return true;
  if (
    providerId === "anthropic-subscription" &&
    route.backend === "anthropic"
  ) {
    return true;
  }
  return providerId === "openai-codex" && route.backend === "openai";
}
/**
 * Live read of the configured per-provider selection (the app's
 * `config.accountStrategies` picker plus any llmText service-routing pin).
 * Every account-selecting bridge resolves through this so the picker steers
 * all of them — including the coding-agent bridge.
 */
export function selectionForProvider(
  providerId: PoolProviderId,
  opts: {
    includeProviderDefault?: boolean;
  } = {},
): {
  strategy?: Strategy;
  accountIds?: string[];
} {
  const route = defaultSelectionConfig.serviceRouting?.llmText;
  const routeSelection = routeTargetsProvider(route, providerId)
    ? {
        strategy: normalizeStrategy(route?.strategy),
        accountIds: normalizeAccountIdsFromRoute(route),
      }
    : {};
  return {
    strategy:
      routeSelection.strategy ??
      normalizeStrategy(
        defaultSelectionConfig.accountStrategies?.[providerId],
      ) ??
      (opts.includeProviderDefault === false
        ? undefined
        : providerId === "anthropic-subscription"
          ? "drain-soonest-reset"
          : undefined),
    accountIds: routeSelection.accountIds,
  };
}
export function configuredAccountStrategyForProvider(
  providerId: PoolProviderId,
): Strategy | undefined {
  const route = defaultSelectionConfig.serviceRouting?.llmText;
  return (
    (routeTargetsProvider(route, providerId)
      ? normalizeStrategy(route?.strategy)
      : undefined) ??
    normalizeStrategy(defaultSelectionConfig.accountStrategies?.[providerId])
  );
}
export function configureDefaultAccountPoolSelection(
  config: AccountPoolSelectionConfig = {},
): void {
  defaultSelectionConfig = {
    accountStrategies: config.accountStrategies ?? {},
    serviceRouting: config.serviceRouting ?? null,
  };
}
