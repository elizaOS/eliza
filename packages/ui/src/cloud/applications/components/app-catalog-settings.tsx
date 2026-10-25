/** Renders registration-bound merchant and immutable plan administration using the canonical SDK and recoverable command state. */
import { CloudApiError } from "@elizaos/cloud-sdk";
import type {
  AppBillingAdminClient,
  AppBillingAdministration,
  AppBillingAdminOperation,
  AppBillingAdminPlan,
  AppBillingMerchant,
  RegisterAppBillingMerchantRequest,
} from "@elizaos/cloud-sdk/app-billing-admin";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { NativeSelect } from "../../../components/ui/native-select";
import { billingHostedUrl } from "../../billing/apps/billing-intent";
import {
  type CatalogIntent,
  type CatalogScope,
  dispatchCatalogIntent,
  type PendingCatalogIntent,
  readCatalogIntent,
  writeCatalogIntent,
} from "./app-catalog-intent";
import { AppNotificationSettings } from "./app-notification-settings";
import { AppPlanForm } from "./app-plan-form";
import { AppRefundForm } from "./app-refund-form";

export interface AppCatalogSettingsProps {
  client: AppBillingAdminClient;
  appId: string;
  userId: string;
  storage?: Storage;
}
export function AppCatalogSettings(props: AppCatalogSettingsProps) {
  const [data, setData] = useState<AppBillingAdministration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState("");
  const generation = useRef(0);
  const id = useId();
  const reload = useCallback(async () => {
    const current = ++generation.current;
    setReady(false);
    setError(null);
    try {
      const result = (await props.client.overview()).data;
      if (result.appId !== props.appId)
        throw new Error(
          "Catalog returned a different app. Reopen the app settings.",
        );
      if (current === generation.current) {
        setData(result);
        setReady(true);
      }
    } catch (cause) {
      // error-policy:J4 failed reads remain unavailable and cannot enable stale merchant or plan mutations.
      if (current === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Catalog could not be loaded",
        );
      throw cause;
    }
  }, [props.client, props.appId]);
  useEffect(() => {
    // error-policy:J5 reload exposes the same failure in the catalog error boundary.
    void reload().catch(() => undefined);
    return () => {
      generation.current++;
    };
  }, [reload]);
  const registration = data?.registrations.find(
    (item) => item.id === selection && item.active,
  );
  return (
    <Card
      variant="outlinedPadded"
      stack="default"
      role="region"
      aria-label="App subscription catalog"
    >
      <h2 className="text-xl font-semibold">App subscriptions</h2>
      <p>
        Set up your merchant account and subscription plans. Customers purchase
        this app independently with a free Eliza account.
      </p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading app catalog…</p>}
      <Button
        size="touch"
        variant="outline"
        onClick={() => {
          // error-policy:J5 reload renders the same error above.
          void reload().catch(() => undefined);
        }}
      >
        Refresh catalog
      </Button>
      {data &&
        (data.registrations.every((item) => !item.active) ? (
          <p>Register an app client above before configuring subscriptions.</p>
        ) : (
          <>
            <label className="block" htmlFor={`${id}-client`}>
              App client and billing environment
            </label>
            <NativeSelect
              id={`${id}-client`}
              value={selection}
              onChange={(event) => setSelection(event.target.value)}
            >
              <option value="">Choose a registered client</option>
              {data.registrations
                .filter((item) => item.active)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.environment === "test" ? "Test" : "Live"} · {item.id}
                  </option>
                ))}
            </NativeSelect>
            {registration && (
              <SelectedCatalog
                key={`${props.appId}:${props.userId}:${registration.id}:${registration.environment}`}
                {...props}
                data={data}
                ready={ready}
                reload={reload}
                scope={{
                  appId: props.appId,
                  userId: props.userId,
                  clientRegistrationId: registration.id,
                  environment: registration.environment,
                }}
              />
            )}
          </>
        ))}
    </Card>
  );
}
function SelectedCatalog({
  client,
  data,
  ready,
  reload,
  scope: initialScope,
  storage: providedStorage,
}: AppCatalogSettingsProps & {
  data: AppBillingAdministration;
  ready: boolean;
  reload: () => Promise<void>;
  scope: CatalogScope;
}) {
  const [scope] = useState(initialScope);
  const storage = providedStorage ?? window.sessionStorage;
  const [pending, setPending] = useState<PendingCatalogIntent | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [operation, setOperation] = useState<AppBillingAdminOperation | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [merchantId, setMerchantId] = useState("");
  const [confirmation, setConfirmation] = useState<
    | { kind: "disconnect"; merchant: AppBillingMerchant }
    | { kind: "publish" | "retire"; plan: AppBillingAdminPlan }
    | null
  >(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const id = useId();
  const merchants = data.merchants.filter(
    (item) => item.environment === scope.environment,
  );
  const plans = data.plans.filter(
    (item) => item.environment === scope.environment,
  );
  const operations = data.operations.filter(
    (item) =>
      item.clientRegistrationId === scope.clientRegistrationId &&
      item.environment === scope.environment,
  );
  const selectedMerchant = merchants.find(
    (item) =>
      item.id === merchantId &&
      item.enabled &&
      item.connectionStatus === "ready",
  );
  useEffect(() => {
    mounted.current = true;
    try {
      setPending(readCatalogIntent(storage, scope));
      setRecovered(true);
    } catch (cause) {
      // error-policy:J4 unreadable local intent blocks new creations instead of risking a duplicate.
      setError(
        cause instanceof Error
          ? cause.message
          : "Saved billing request could not be read",
      );
    }
    return () => {
      mounted.current = false;
    };
  }, [storage, scope]);
  const perform = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (cause) {
      // error-policy:J4 command and provider failures stay visible without inventing a plan or healthy merchant.
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Catalog request could not be completed",
        );
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const accept = async (
    result: AppBillingAdminOperation,
    saved: PendingCatalogIntent | null,
  ) => {
    if (result.status === "refund") {
      if (
        result.receipt.environment !== scope.environment ||
        result.receipt.accessPolicy !== "preserve" ||
        (saved &&
          (saved.intent.kind !== "refund" ||
            saved.intent.request.paidPeriodId !== result.receipt.paidPeriodId ||
            saved.intent.request.amountCents !== result.receipt.amountCents))
      )
        throw new Error(
          "Refund receipt differs from the selected payment and environment",
        );
      if (saved) writeCatalogIntent(storage, scope, null);
      if (mounted.current) {
        if (saved) setPending(null);
        setOperation(result);
      }
    } else if (result.status === "succeeded") {
      if (
        (result.merchant &&
          result.merchant.environment !== scope.environment) ||
        (result.plan &&
          (result.plan.environment !== scope.environment ||
            result.plan.appId !== scope.appId))
      )
        throw new Error(
          "Catalog operation returned a different app or environment",
        );
      if (saved) writeCatalogIntent(storage, scope, null);
      if (mounted.current) {
        if (saved) setPending(null);
        setOperation(result);
        setNotice("Catalog operation completed.");
      }
    } else {
      if (result.status === "requires_action")
        billingHostedUrl(result.action.url);
      if (saved) {
        const next = { ...saved, operationId: result.id };
        writeCatalogIntent(storage, scope, next);
        if (mounted.current) setPending(next);
      }
      if (mounted.current) setOperation(result);
    }
    await reload();
  };
  const send = async (intent: CatalogIntent) => {
    const saved = { intent, operationId: null };
    writeCatalogIntent(storage, scope, saved);
    setPending(saved);
    try {
      await accept((await dispatchCatalogIntent(client, intent)).data, saved);
    } catch (cause) {
      // error-policy:J2 retain uncertain intents; only definitive input rejection permits a corrected new request.
      if (
        cause instanceof CloudApiError &&
        [400, 422].includes(cause.statusCode)
      ) {
        writeCatalogIntent(storage, scope, null);
        if (mounted.current) setPending(null);
      }
      throw cause;
    }
  };
  const base = () => ({
    clientRegistrationId: scope.clientRegistrationId,
    idempotencyKey: crypto.randomUUID(),
  });
  const disabled = busy || !ready || !recovered;
  const creationDisabled =
    disabled || pending !== null || operations.length > 0;
  return (
    <div className="space-y-5">
      <p className="font-semibold">
        {scope.environment === "test"
          ? "Test billing · sandbox data only"
          : "Live billing · published plans accept real purchases"}
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <Card variant="insetPadded" stack="compact">
          <h3 className="font-semibold">Saved billing request</h3>
          <p>
            This request may already exist. Recover it before creating another
            billing request.
          </p>
          <Button
            size="touch"
            disabled={disabled}
            onClick={() =>
              void perform(async () => {
                if (pending.operationId)
                  await accept(
                    (await client.recoverOperation(pending.operationId)).data,
                    pending,
                  );
                else await send(pending.intent);
              })
            }
          >
            Recover saved request
          </Button>
        </Card>
      )}
      {operations.length > 0 && (
        <section aria-label="Pending catalog operations" className="space-y-3">
          <h3 className="font-semibold">Pending operations</h3>
          {operations.map((item) => (
            <div className="space-y-2" key={item.id}>
              <p>
                {item.action.replaceAll("_", " ")} ·{" "}
                {item.status === "outcome_unknown"
                  ? "Provider result unknown"
                  : item.status === "requires_action"
                    ? "Merchant setup required"
                    : "Pending"}{" "}
                · {new Date(item.createdAt).toLocaleString()}
              </p>
              <Button
                size="touch"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  void perform(async () =>
                    accept(
                      (await client.recoverOperation(item.id)).data,
                      pending?.operationId === item.id ? pending : null,
                    ),
                  )
                }
              >
                Recover {item.action.replaceAll("_", " ")}
              </Button>
            </div>
          ))}
        </section>
      )}
      {operation?.status === "outcome_unknown" && (
        <p role="status">
          The provider result is still unknown. Refresh or recover this
          operation before retrying a new request.
        </p>
      )}
      {operation?.status === "refund" && (
        <Card variant="insetPadded" stack="compact" role="status">
          <h3 className="font-semibold">
            Refund{" "}
            {operation.receipt.providerStatus === "requires_action"
              ? "requires action"
              : operation.receipt.providerStatus}
          </h3>
          <p>
            {new Intl.NumberFormat(undefined, {
              style: "currency",
              currency: operation.receipt.currency,
            }).format(operation.receipt.amountCents / 100)}{" "}
            · Subscription access and renewal remain unchanged. Cloud credits
            and allowance are unchanged.
          </p>
          <Button
            size="touch"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void perform(async () =>
                accept(
                  (await client.recoverOperation(operation.id)).data,
                  null,
                ),
              )
            }
          >
            Refresh refund status
          </Button>
        </Card>
      )}
      <AppRefundForm
        client={client}
        scope={scope}
        disabled={creationDisabled}
        key={operation?.status === "refund" ? operation.id : "payments"}
        onSubmit={(intent) => void perform(() => send(intent))}
        onRecover={(commandId) =>
          void perform(async () =>
            accept((await client.recoverOperation(commandId)).data, null),
          )
        }
      />
      {operation?.status === "requires_action" && (
        <Card variant="insetPadded" stack="compact">
          <p>
            Complete merchant setup with the payment provider. This link expires{" "}
            {new Date(operation.action.expiresAt).toLocaleString()}.
          </p>
          <a
            href={billingHostedUrl(operation.action.url)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Continue merchant setup
          </a>
        </Card>
      )}
      <section className="space-y-4" aria-label="Merchant accounts">
        <h3 className="font-semibold">Merchant accounts</h3>
        {merchants.length === 0 && <p>No merchants in this environment.</p>}
        {merchants.map((merchant) => (
          <Card key={merchant.id} variant="insetPadded" stack="compact">
            <p className="break-all">{merchant.id}</p>
            <p>
              {merchant.kind === "platform"
                ? "Platform merchant"
                : "Connected merchant"}{" "}
              · {merchant.connectionStatus} ·{" "}
              {merchant.enabled ? "New sales enabled" : "New sales disabled"}
            </p>
            <p>
              {merchant.capabilities === null
                ? "Provider capabilities have not been verified."
                : `Charges: ${merchant.capabilities.charges ? "enabled" : "unavailable"}; payouts: ${merchant.capabilities.payouts ? "enabled" : "unavailable"}; card payments: ${merchant.capabilities.cardPayments ? "enabled" : "unavailable"}.`}
            </p>
            <p>
              {merchant.requirementsDue === null
                ? "Provider requirements have not been retrieved."
                : merchant.requirementsDue.length
                  ? `Required: ${merchant.requirementsDue.join(", ")}`
                  : "No outstanding provider requirements."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="touch"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  void perform(async () => {
                    await client.refreshMerchant({
                      ...base(),
                      merchantId: merchant.id,
                    });
                    await reload();
                  })
                }
              >
                Refresh merchant status
              </Button>
              {merchant.kind === "connected" &&
                merchant.connectionStatus !== "ready" && (
                  <Button
                    size="touch"
                    variant="outline"
                    disabled={creationDisabled}
                    onClick={() =>
                      void perform(() =>
                        send({
                          kind: "onboard",
                          request: { ...base(), merchantId: merchant.id },
                        }),
                      )
                    }
                  >
                    Set up merchant
                  </Button>
                )}
              {merchant.enabled && (
                <Button
                  size="touch"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    setConfirmation({ kind: "disconnect", merchant })
                  }
                >
                  Disable new sales
                </Button>
              )}
            </div>
          </Card>
        ))}
        <MerchantForm
          disabled={creationDisabled}
          submit={(input) =>
            void perform(() =>
              send({ kind: "merchant", request: { ...input, ...base() } }),
            )
          }
        />
      </section>
      {confirmation && (
        <Card
          variant="insetPadded"
          stack="compact"
          role="region"
          aria-label="Confirm catalog change"
        >
          <h3 className="font-semibold">
            {confirmation.kind === "disconnect"
              ? "Disable new sales for this merchant?"
              : confirmation.kind === "publish"
                ? `Publish ${confirmation.plan.name}?`
                : `Retire ${confirmation.plan.name}?`}
          </h3>
          <p>
            {confirmation.kind === "disconnect"
              ? "Existing subscriptions and their billing continue. New purchases using this merchant will be disabled."
              : confirmation.kind === "publish"
                ? "New customers can purchase these verified terms. Existing subscriptions remain on their current version."
                : "This version will no longer accept new purchases. Existing subscriptions continue."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="touch"
              disabled={disabled}
              onClick={() =>
                void perform(async () => {
                  if (confirmation.kind === "disconnect") {
                    const result = (
                      await client.disconnectMerchant({
                        ...base(),
                        merchantId: confirmation.merchant.id,
                        expectedRevision: confirmation.merchant.revision,
                        confirmation: "disable_new_sales_for_merchant",
                      })
                    ).data;
                    setNotice(
                      `New sales disabled. ${result.activeSubscriptionCount} existing subscriptions continue billing.`,
                    );
                  } else {
                    const request = {
                      ...base(),
                      planRevisionId: confirmation.plan.id,
                    };
                    if (confirmation.kind === "publish")
                      await client.publishPlan(request);
                    else await client.retirePlan(request);
                  }
                  setConfirmation(null);
                  await reload();
                })
              }
            >
              Confirm{" "}
              {confirmation.kind === "disconnect"
                ? "disable new sales"
                : confirmation.kind}
            </Button>
            <Button
              size="touch"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Keep current settings
            </Button>
          </div>
        </Card>
      )}
      <section className="space-y-4" aria-label="Subscription plan versions">
        <h3 className="font-semibold">Plan versions</h3>
        {plans.length === 0 && (
          <p>
            No verified plan rows in this environment. Pending creation requests
            appear above.
          </p>
        )}
        {plans.map((plan) => (
          <Card key={plan.id} variant="insetPadded" stack="compact">
            <p className="font-semibold">
              {plan.name} · Version {plan.revision} · {plan.state}
            </p>
            <p>
              {new Intl.NumberFormat(undefined, {
                style: "currency",
                currency: plan.currency,
              }).format(plan.amountCents / 100)}{" "}
              per seat every {plan.intervalCount} {plan.interval} ·{" "}
              {plan.seats.minimum}–{plan.seats.maximum} seats
            </p>
            <p>
              Seven-day trial · Trial allowance ${plan.trial.allowanceUsd} USD ·
              Paid allowance ${plan.allowanceUsd} USD · Expired access:{" "}
              {plan.expiredAccess === "read_only" ? "read only" : "none"}
            </p>
            <p className="break-all">
              Product family: {plan.productFamilyKey} · Plan: {plan.planKey}
            </p>
            <div className="flex flex-wrap gap-2">
              {plan.state === "draft" && (
                <Button
                  size="touch"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void perform(async () => {
                      await client.verifyPlan({
                        ...base(),
                        planRevisionId: plan.id,
                      });
                      await reload();
                    })
                  }
                >
                  Verify {plan.name}
                </Button>
              )}
              {plan.state === "verified" && (
                <Button
                  size="touch"
                  disabled={disabled}
                  onClick={() => setConfirmation({ kind: "publish", plan })}
                >
                  Publish {plan.name}
                </Button>
              )}
              {plan.state !== "retired" && (
                <Button
                  size="touch"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setConfirmation({ kind: "retire", plan })}
                >
                  Retire {plan.name}
                </Button>
              )}
            </div>
          </Card>
        ))}
      </section>
      <label className="block" htmlFor={`${id}-merchant`}>
        Verified merchant for a new plan
      </label>
      <NativeSelect
        id={`${id}-merchant`}
        value={merchantId}
        disabled={creationDisabled}
        onChange={(event) => setMerchantId(event.target.value)}
      >
        <option value="">Choose a ready merchant</option>
        {merchants
          .filter((item) => item.enabled && item.connectionStatus === "ready")
          .map((item) => (
            <option value={item.id} key={item.id}>
              {item.kind} · {item.id}
            </option>
          ))}
      </NativeSelect>
      {selectedMerchant && (
        <AppPlanForm
          key={selectedMerchant.id}
          merchantId={selectedMerchant.id}
          clientRegistrationId={scope.clientRegistrationId}
          disabled={creationDisabled}
          onSubmit={(intent) => void perform(() => send(intent))}
        />
      )}
      <AppNotificationSettings
        client={client}
        appId={scope.appId}
        clientRegistrationId={scope.clientRegistrationId}
        environment={scope.environment}
      />
    </div>
  );
}
function MerchantForm({
  disabled,
  submit,
}: {
  disabled: boolean;
  submit: (
    input:
      | Omit<
          Extract<
            RegisterAppBillingMerchantRequest,
            { mode: "create_connected" }
          >,
          "clientRegistrationId" | "idempotencyKey"
        >
      | Omit<
          Extract<RegisterAppBillingMerchantRequest, { mode: "adopt_creator" }>,
          "clientRegistrationId" | "idempotencyKey"
        >
      | { mode: "platform" },
  ) => void;
}) {
  const [mode, setMode] = useState("create_connected");
  const id = useId();
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        submit(
          mode === "platform"
            ? { mode }
            : mode === "adopt_creator"
              ? { mode, creatorConnectionId: String(form.get("connection")) }
              : {
                  mode: "create_connected",
                  country: String(form.get("country")).toUpperCase(),
                },
        );
      }}
    >
      <h4 className="font-semibold">Register a merchant</h4>
      <fieldset disabled={disabled} className="space-y-3">
        <label htmlFor={`${id}-mode`}>Merchant source</label>
        <NativeSelect
          id={`${id}-mode`}
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="create_connected">Create a connected merchant</option>
          <option value="adopt_creator">
            Use an existing creator connection
          </option>
          <option value="platform">
            Use platform merchant (authorized apps)
          </option>
        </NativeSelect>
        {mode === "create_connected" && (
          <div>
            <label htmlFor={`${id}-country`}>Country code</label>
            <Input
              id={`${id}-country`}
              name="country"
              required
              pattern="[A-Za-z]{2}"
              placeholder="US"
            />
          </div>
        )}
        {mode === "adopt_creator" && (
          <div>
            <label htmlFor={`${id}-connection`}>Creator connection ID</label>
            <Input id={`${id}-connection`} name="connection" required />
          </div>
        )}
        <Button size="touch" type="submit">
          Register merchant
        </Button>
      </fieldset>
    </form>
  );
}
