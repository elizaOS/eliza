import {
  type LegacyWebhookEventType,
  type WebhookCatalogEventType,
  WebhookEventRegistry,
  type WebhookEventType,
} from "../../../shared/src/index.ts";

export const CONFIGURED_WEBHOOK_EVENT_TYPES = [
  "tx.pending",
  "tx.approved",
  "tx.denied",
  "tx.signed",
  "spend.threshold",
  "policy.violation",
  "user.created",
  "user.authenticated",
  "user.linked_account",
  "user.unlinked_account",
  "user.updated_account",
  "user.transferred_account",
  "user.wallet_created",
  "mfa.enabled",
  "mfa.disabled",
  "private_key.exported",
  "wallet.imported",
  "wallet.recovery_setup",
  "wallet.recovered",
  "wallet.raw_signature.created",
  "wallet.funds_deposited",
  "wallet.funds_withdrawn",
  "wallet.frozen",
  "wallet.unfrozen",
  "transaction.broadcasted",
  "transaction.confirmed",
  "transaction.execution_reverted",
  "transaction.replaced",
  "transaction.failed",
  "transaction.provider_error",
  "transaction.still_pending",
  "user_operation.completed",
  "user_operation.failed",
  "intent.created",
  "intent.authorized",
  "intent.executed",
  "intent.failed",
  "intent.rejected",
  "intent.canceled",
  "intent.expired",
  "wallet_action.transfer.created",
  "wallet_action.transfer.succeeded",
  "wallet_action.transfer.rejected",
  "wallet_action.transfer.failed",
  "wallet_action.swap.created",
  "wallet_action.swap.succeeded",
  "wallet_action.swap.rejected",
  "wallet_action.swap.failed",
  "wallet_action.send_calls.created",
  "wallet_action.send_calls.succeeded",
  "wallet_action.send_calls.rejected",
  "wallet_action.send_calls.failed",
  "wallet_action.earn_deposit.created",
  "wallet_action.earn_deposit.succeeded",
  "wallet_action.earn_deposit.rejected",
  "wallet_action.earn_deposit.failed",
  "wallet_action.earn_withdraw.created",
  "wallet_action.earn_withdraw.succeeded",
  "wallet_action.earn_withdraw.rejected",
  "wallet_action.earn_withdraw.failed",
  "wallet_action.earn_incentive_claim.created",
  "wallet_action.earn_incentive_claim.succeeded",
  "wallet_action.earn_incentive_claim.rejected",
  "wallet_action.earn_incentive_claim.failed",
] as const satisfies readonly WebhookCatalogEventType[];

export type ConfiguredWebhookEventType =
  (typeof CONFIGURED_WEBHOOK_EVENT_TYPES)[number];
type VaultWebhookEventAlias = LegacyWebhookEventType;

/**
 * The event-type a caller may pass to `dispatchWebhook`. Core event names
 * (`WebhookEventType`) stay autocompleted/typed; the `(string & {})` arm widens
 * the type so a PLUGIN-declared event name (one the plugin host merged into the
 * runtime {@link webhookEventRegistry}) can also be emitted, WITHOUT the core's
 * closed union having to enumerate it. The widening is a TYPE accommodation only:
 * `dispatchWebhook` VALIDATES the name against the runtime registry (core ∪
 * plugin-declared) and drops an unregistered name, so an arbitrary unvalidated
 * string can never flow through.
 */
export type DispatchableWebhookEventType = WebhookEventType | (string & {});

const CONFIGURED_EVENT_SET = new Set<string>(CONFIGURED_WEBHOOK_EVENT_TYPES);
const VAULT_EVENT_ALIAS_MAP: Partial<
  Record<VaultWebhookEventAlias, ConfiguredWebhookEventType>
> = {
  approval_required: "tx.pending",
  tx_signed: "tx.signed",
  tx_confirmed: "transaction.confirmed",
  tx_failed: "transaction.failed",
  tx_rejected: "policy.violation",
};

export function toConfiguredWebhookEventType(
  type: DispatchableWebhookEventType,
): ConfiguredWebhookEventType | null {
  if (CONFIGURED_EVENT_SET.has(type as WebhookEventType)) {
    return type as ConfiguredWebhookEventType;
  }
  return VAULT_EVENT_ALIAS_MAP[type as VaultWebhookEventAlias] ?? null;
}

export function acceptsConfiguredWebhookEvent(
  events: string[],
  type: ConfiguredWebhookEventType,
): boolean {
  return events.length === 0 || events.includes(type);
}

/**
 * Process-wide registry of valid webhook event names, seeded with the core
 * configured event types. The plugin host merges each enabled plugin's declared
 * `webhookEvents` into THIS registry at the composition root, so the webhook
 * config/dispatch validation accepts a plugin's event type (core ∪
 * plugin-declared) without the core's closed union having to enumerate it.
 *
 * Core events are seeded here and can never be removed: a plugin can only ADD to
 * the valid set. Tests that compose plugins against an isolated registry can
 * construct their own {@link WebhookEventRegistry}.
 */
export const webhookEventRegistry = new WebhookEventRegistry(
  CONFIGURED_WEBHOOK_EVENT_TYPES,
);

/**
 * True when `type` is a valid webhook event name to CONFIGURE on a subscription:
 * a core configured event OR an event a registered plugin declared. This is the
 * runtime-extensible replacement for checking membership of the frozen
 * `CONFIGURED_WEBHOOK_EVENT_TYPES` list directly.
 */
export function isValidConfigurableWebhookEvent(type: string): boolean {
  return webhookEventRegistry.has(type);
}

/** Every currently-valid configurable webhook event name (core ∪ plugin), sorted. */
export function listValidConfigurableWebhookEvents(): string[] {
  return webhookEventRegistry.list();
}
