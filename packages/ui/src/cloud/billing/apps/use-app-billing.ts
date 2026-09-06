/** Coordinates SDK reads, confirmed mutations, and durable retry state for one app/account/environment. */
import { CloudApiError } from "@elizaos/cloud-sdk";
import type {
  AppBillingCatalog,
  AppBillingClient,
  AppBillingOperation,
  AppBillingSnapshot,
  AppBillingUpdateQuote,
} from "@elizaos/cloud-sdk/app-billing";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BillingIntent,
  type BillingIntentScope,
  dispatchBillingIntent,
  type PendingBillingIntent,
  readBillingIntent,
  writeBillingIntent,
} from "./billing-intent";

export interface AppBillingPanelProps {
  client: AppBillingClient;
  appId: string;
  userId: string;
  productFamilyKey: string;
  accountId?: string;
  clientId?: string;
  storage?: Storage;
}
export interface LoadedAppBilling {
  catalog: AppBillingCatalog;
  snapshot: AppBillingSnapshot;
  scope: BillingIntentScope;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Billing is unavailable. Try again.";

export function useAppBilling(props: AppBillingPanelProps) {
  const { client, appId, userId, productFamilyKey, accountId, clientId } =
    props;
  const [loaded, setLoaded] = useState<LoadedAppBilling | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingBillingIntent | null>(null);
  const [operation, setOperation] = useState<AppBillingOperation | null>(null);
  const [quote, setQuote] = useState<AppBillingUpdateQuote | null>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  const storage = useCallback(
    () => props.storage ?? window.sessionStorage,
    [props.storage],
  );
  const load = useCallback(async () => {
    if (mounted.current) setReady(false);
    const catalog = (await client.getCatalog()).data;
    const resolvedId =
      accountId ??
      (
        await client.resolveAccount({
          externalReference: null,
          displayName: "Personal account",
        })
      ).data.id;
    const snapshot = (
      await client.getSubscription(resolvedId, productFamilyKey)
    ).data;
    if (
      catalog.appId !== appId ||
      snapshot.account.appId !== appId ||
      snapshot.account.id !== resolvedId ||
      snapshot.productFamilyKey !== productFamilyKey ||
      catalog.environment !== snapshot.environment
    ) {
      throw new Error(
        "Billing returned a different app, account, or environment. Reopen billing from your app.",
      );
    }
    const result = {
      catalog,
      snapshot,
      scope: {
        appId,
        userId,
        clientId: clientId ?? null,
        accountId: resolvedId,
        environment: snapshot.environment,
        productFamilyKey,
      },
    };
    if (mounted.current) setLoaded(result);
    return result;
  }, [client, appId, userId, clientId, accountId, productFamilyKey]);

  const acceptOperation = useCallback(
    async (
      next: AppBillingOperation,
      request: PendingBillingIntent,
      scope: BillingIntentScope,
    ) => {
      if (
        next.appId !== scope.appId ||
        next.billingAccountId !== scope.accountId ||
        next.productFamilyKey !== scope.productFamilyKey ||
        next.environment !== scope.environment
      )
        throw new Error("Billing operation does not match this account");
      const terminal =
        next.status === "succeeded" ||
        (next.status === "failed" && !next.error.retryable);
      const saved = terminal ? null : { ...request, operationId: next.id };
      writeBillingIntent(storage(), scope, saved);
      if (!mounted.current) return;
      setPending(saved);
      setOperation(next);
      setQuote(null);
      if (terminal) {
        await load();
        if (mounted.current) setReady(true);
      }
    },
    [load, storage],
  );

  const recover = useCallback(
    async (request: PendingBillingIntent, scope: BillingIntentScope) => {
      try {
        const next = request.operationId
          ? (await client.getOperation(scope.accountId, request.operationId))
              .data
          : request.intent
            ? await dispatchBillingIntent(client, scope, request.intent)
            : (() => {
                throw new Error(
                  "The saved billing request has no recoverable operation",
                );
              })();
        await acceptOperation(next, request, scope);
      } catch (cause) {
        // error-policy:J4 discard only a receipt-checked transaction rollback; status alone cannot resolve an earlier lost response.
        if (
          !request.operationId &&
          cause instanceof CloudApiError &&
          cause.statusCode === 409 &&
          cause.errorBody?.code === "APP_BILLING_COMMAND_NOT_APPLIED"
        ) {
          writeBillingIntent(storage(), scope, null);
          if (mounted.current) {
            setPending(null);
            setQuote(null);
          }
          const current = await load();
          if (mounted.current) setReady(true);
          if (current.snapshot.pendingOperation && mounted.current) {
            const serverRequest = {
              intent: null,
              operationId: current.snapshot.pendingOperation.id,
            };
            await acceptOperation(
              current.snapshot.pendingOperation,
              serverRequest,
              scope,
            );
          }
        }
        throw cause;
      }
    },
    [client, acceptOperation, storage, load],
  );

  useEffect(() => {
    mounted.current = true;
    lock.current = true;
    setBusy(true);
    void (async () => {
      try {
        const result = await load();
        const saved = readBillingIntent(storage(), result.scope);
        const request =
          saved ??
          (result.snapshot.pendingOperation
            ? { intent: null, operationId: result.snapshot.pendingOperation.id }
            : null);
        if (!mounted.current) return;
        setReady(true);
        setPending(request);
        if (request) await recover(request, result.scope);
      } catch (cause) {
        // error-policy:J4 billing transport/storage failures remain visibly unavailable, never an empty account.
        if (mounted.current) setError(message(cause));
      } finally {
        lock.current = false;
        if (mounted.current) setBusy(false);
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [load, recover, storage]);

  useEffect(() => {
    if (
      !loaded ||
      !pending ||
      !operation ||
      operation.status === "failed" ||
      operation.status === "succeeded" ||
      (operation.status === "requires_action" &&
        operation.action.kind === "portal")
    )
      return;
    const delay =
      operation.status === "requires_action"
        ? 5000
        : Math.max(1000, operation.retryAfterSeconds * 1000);
    const timer = setInterval(() => {
      if (lock.current) return;
      lock.current = true;
      void recover(pending, loaded.scope)
        .catch((cause: unknown) => {
          // error-policy:J4 retain the durable operation and expose polling failure for manual recovery.
          if (mounted.current) setError(message(cause));
        })
        .finally(() => {
          lock.current = false;
        });
    }, delay);
    return () => clearInterval(timer);
  }, [loaded, pending, operation, recover]);

  const run = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      // error-policy:J4 preserve the saved request on an uncertain response and show a recoverable error.
      if (mounted.current) setError(message(cause));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const refresh = () =>
    run(async () => {
      const current = await load();
      const request =
        readBillingIntent(storage(), current.scope) ??
        (current.snapshot.pendingOperation
          ? { intent: null, operationId: current.snapshot.pendingOperation.id }
          : null);
      setReady(true);
      setPending(request);
      if (request) await recover(request, current.scope);
    });
  const submit = (intent: BillingIntent, replaceCheckout = false) =>
    run(async () => {
      if (loaded?.snapshot.account.role !== "administrator")
        throw new Error(
          "Only a billing administrator can change this subscription",
        );
      if (pending && !replaceCheckout)
        throw new Error(
          "Recover the current billing request before starting another",
        );
      const saved = { intent, operationId: null };
      writeBillingIntent(storage(), loaded.scope, saved);
      setPending(saved);
      setOperation(null);
      await recover(saved, loaded.scope);
    });
  const getQuote = (planRevisionId: string, quantity: number) =>
    run(async () => {
      if (!loaded || pending) return;
      const result = (
        await client.quoteSubscriptionUpdate(
          loaded.scope.accountId,
          productFamilyKey,
          {
            planRevisionId,
            quantity,
            idempotencyKey: crypto.randomUUID(),
            expectedSubscriptionRevision: loaded.snapshot.mutationRevision,
          },
        )
      ).data;
      if (
        result.appId !== appId ||
        result.billingAccountId !== loaded.scope.accountId ||
        result.productFamilyKey !== productFamilyKey ||
        result.planRevisionId !== planRevisionId ||
        result.quantity !== quantity
      )
        throw new Error("Billing returned a quote for a different selection");
      if (mounted.current) setQuote(result);
    });
  const retry = () =>
    run(async () => {
      if (!loaded || !pending) return;
      if (
        operation?.status === "failed" &&
        operation.error.retryable &&
        pending.intent
      ) {
        const saved = { ...pending, operationId: null };
        writeBillingIntent(storage(), loaded.scope, saved);
        await recover(saved, loaded.scope);
      } else await recover(pending, loaded.scope);
    });
  const dismissPortal = () =>
    run(async () => {
      if (
        !loaded ||
        operation?.status !== "requires_action" ||
        operation.action.kind !== "portal"
      )
        return;
      writeBillingIntent(storage(), loaded.scope, null);
      setPending(null);
      setOperation(null);
      await load();
    });
  return {
    loaded,
    ready,
    error,
    busy,
    pending,
    operation,
    quote,
    setQuote,
    refresh,
    submit,
    getQuote,
    retry,
    dismissPortal,
  };
}
