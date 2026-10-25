/** React orchestration for durable, resumable billable-resource cancellation. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createTimeoutSignal,
  isTimeoutAbortError,
} from "../../../api/timeout-signal";
import {
  BillingCancellationHttpError,
  type BillingCancellationReceipt,
  readBillingCancellationReceipt,
  requestBillingCancellation,
} from "../data/billing-resource-cancellation";
import type { BillingSnapshotResource } from "../data/billing-snapshot";
import {
  type BillingCancelBoundIntentHandle,
  type BillingCancelIntentCoordinator,
  type BillingCancelIntentHandle,
  type BillingCancelIntentIdentity,
  billingCancelIntentCoordinator,
} from "./billing-cancel-intent";
import {
  type ActiveComputeCancellationViewState,
  billingCancellationIdentityKey,
} from "./billing-resource-cancellation-view";

const DEFAULT_RECEIPT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_NETWORK_TIMEOUT_MS = 15_000;

interface CancellationContext {
  generation: number;
  signature: string;
  receiptResource: BillingSnapshotResource;
  displayResource: BillingSnapshotResource;
  handle: BillingCancelIntentHandle;
  blocksNewerRevision: boolean;
}

interface CancellationStateEnvelope {
  signature: string;
  values: Record<string, ActiveComputeCancellationViewState>;
}

interface CancellationPollControl {
  context: CancellationContext;
  nextSequence: number;
  lastAppliedSequence: number;
  terminal: boolean;
  inFlight: Promise<void> | null;
}

const EMPTY_CANCELLATION_STATES: Readonly<
  Record<string, ActiveComputeCancellationViewState>
> = Object.freeze({});

export interface UseBillingResourceCancellationsOptions {
  organizationId: string;
  initiatedByUserId: string;
  resources: readonly BillingSnapshotResource[] | null;
  coordinator?: BillingCancelIntentCoordinator;
  onTerminal: () => unknown;
  pollIntervalMs?: number;
  networkTimeoutMs?: number;
}

export interface BillingResourceCancellationController {
  states: Readonly<Record<string, ActiveComputeCancellationViewState>>;
  request: (resource: BillingSnapshotResource) => Promise<void>;
  checkReceipt: (resource: BillingSnapshotResource) => Promise<void>;
}

function identityFor(
  organizationId: string,
  initiatedByUserId: string,
  resource: BillingSnapshotResource,
): BillingCancelIntentIdentity {
  return {
    organizationId,
    initiatedByUserId,
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    expectedLifecycleRevision:
      resource.cancellationControl.expectedLifecycleRevision,
    endpoint: resource.cancellationControl.endpoint,
  };
}

function receiptResourceForHandle(
  displayResource: BillingSnapshotResource,
  handle: BillingCancelIntentHandle,
): BillingSnapshotResource | null {
  if (
    handle.resourceType !== displayResource.resourceType ||
    handle.resourceId !== displayResource.resourceId
  ) {
    return null;
  }
  return {
    ...displayResource,
    cancellationControl: {
      ...displayResource.cancellationControl,
      endpoint: handle.endpoint,
      expectedLifecycleRevision: handle.expectedLifecycleRevision,
    },
  };
}

async function withCancellationNetworkTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 120_000
  ) {
    throw new Error("Billing cancellation network timeout is invalid.");
  }
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        timeout.signal.removeEventListener("abort", onAbort);
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        reject(
          timeout.signal.reason ?? new DOMException("Aborted", "AbortError"),
        );
      };

      if (timeout.signal.aborted) {
        onAbort();
        return;
      }
      timeout.signal.addEventListener("abort", onAbort, { once: true });

      let pending: Promise<T>;
      try {
        pending = operation(timeout.signal);
      } catch (error) {
        if (finish()) reject(error);
        return;
      }
      pending.then(
        (value) => {
          if (finish()) resolve(value);
        },
        (error) => {
          // Keep a rejection handler attached after a timeout so a late native
          // bridge failure never becomes an unhandled promise rejection.
          if (finish()) reject(error);
        },
      );
    });
  } finally {
    timeout.dispose();
  }
}

function resumableSignature(
  organizationId: string,
  initiatedByUserId: string,
  resources: readonly BillingSnapshotResource[] | null,
): string {
  return JSON.stringify([
    organizationId,
    initiatedByUserId,
    ...(resources ?? []).map((resource) => [
      resource.resourceType,
      resource.resourceId,
      resource.cancellationControl.expectedLifecycleRevision,
      resource.cancellationControl.endpoint,
      resource.cancellationControl.eligible,
    ]),
  ]);
}

function isTerminalState(state: ActiveComputeCancellationViewState): boolean {
  return (
    state.kind === "provider_confirmed" ||
    state.kind === "conflict" ||
    state.kind === "terminal_attention"
  );
}

function hasAuthoritativeReceipt(
  state: ActiveComputeCancellationViewState,
): boolean {
  return (
    isTerminalState(state) ||
    state.kind === "accepted" ||
    state.kind === "receipt_unavailable"
  );
}

function isRetryableReceiptReadFailure(error: unknown): boolean {
  if (error instanceof BillingCancellationHttpError) return error.retryable;
  // Browser fetch reports transport failures as TypeError. Every other thrown
  // value is a local validation/contract failure and requires an explicit
  // user retry instead of an unbounded automatic loop.
  return error instanceof TypeError || isTimeoutAbortError(error);
}

function terminalRefreshSucceeded(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return true;
  const record = result as Record<string, unknown>;
  return !(
    record.isError === true ||
    record.status === "error" ||
    (Object.hasOwn(record, "error") && record.error != null)
  );
}

function sameBoundContext(
  context: CancellationContext,
  generation: number,
  signature: string,
  handle: BillingCancelIntentHandle,
  displayResource: BillingSnapshotResource,
): boolean {
  return (
    context.generation === generation &&
    context.signature === signature &&
    billingCancellationIdentityKey(context.displayResource) ===
      billingCancellationIdentityKey(displayResource) &&
    context.handle.idempotencyKey === handle.idempotencyKey &&
    context.handle.receiptId === handle.receiptId &&
    context.handle.pollEndpoint === handle.pollEndpoint
  );
}

/**
 * Keeps the command identity durable across tabs/reloads and polls only the
 * tenant-scoped business receipt. Rows remain in the snapshot until a terminal
 * receipt is observed and the caller refreshes server truth.
 */
export function useBillingResourceCancellations({
  organizationId,
  initiatedByUserId,
  resources,
  coordinator = billingCancelIntentCoordinator,
  onTerminal,
  pollIntervalMs = DEFAULT_RECEIPT_POLL_INTERVAL_MS,
  networkTimeoutMs = DEFAULT_NETWORK_TIMEOUT_MS,
}: UseBillingResourceCancellationsOptions): BillingResourceCancellationController {
  const [reconcileVersion, setReconcileVersion] = useState(0);
  const signature = useMemo(
    () =>
      `${resumableSignature(organizationId, initiatedByUserId, resources)}:${reconcileVersion}`,
    [organizationId, initiatedByUserId, reconcileVersion, resources],
  );
  const [stateEnvelope, setStateEnvelope] = useState<CancellationStateEnvelope>(
    () => ({
      signature,
      values: {},
    }),
  );
  const generationRef = useRef(0);
  const latestSignatureRef = useRef(signature);
  latestSignatureRef.current = signature;
  const effectSignatureRef = useRef("");
  const mountedRef = useRef(false);
  const resourcesRef = useRef(resources);
  const principalRef = useRef({ organizationId, initiatedByUserId });
  const contextsRef = useRef(new Map<string, CancellationContext>());
  const pollControlsRef = useRef(new Map<string, CancellationPollControl>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pollRef = useRef<(context: CancellationContext) => Promise<void>>(
    async () => undefined,
  );
  const terminalRef = useRef(onTerminal);
  terminalRef.current = onTerminal;
  resourcesRef.current = resources;
  principalRef.current = { organizationId, initiatedByUserId };

  const clearTimer = useCallback((key: string) => {
    const timer = timersRef.current.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timersRef.current.delete(key);
  }, []);

  const reconcileLateBoundReceipt = useCallback(
    (
      requestOrganizationId: string,
      requestUserId: string,
      resourceType: BillingSnapshotResource["resourceType"],
      resourceId: string,
    ) => {
      const principal = principalRef.current;
      if (
        !mountedRef.current ||
        principal.organizationId !== requestOrganizationId ||
        principal.initiatedByUserId !== requestUserId ||
        !resourcesRef.current?.some(
          (resource) =>
            resource.resourceType === resourceType &&
            resource.resourceId === resourceId,
        )
      ) {
        return;
      }
      setReconcileVersion((current) => current + 1);
    },
    [],
  );

  const setState = useCallback(
    (
      key: string,
      state: ActiveComputeCancellationViewState,
      generation: number,
      operationSignature: string,
    ) => {
      if (
        !mountedRef.current ||
        generationRef.current !== generation ||
        latestSignatureRef.current !== operationSignature ||
        effectSignatureRef.current !== operationSignature
      ) {
        return;
      }
      setStateEnvelope((current) => {
        if (current.signature !== operationSignature) return current;
        const previous = current.values[key];
        if (
          previous &&
          (isTerminalState(previous) ||
            (hasAuthoritativeReceipt(previous) &&
              (state.kind === "submitting" ||
                state.kind === "ambiguous" ||
                state.kind === "rejected")))
        ) {
          return current;
        }
        return {
          signature: current.signature,
          values: { ...current.values, [key]: state },
        };
      });
    },
    [],
  );

  const releaseState = useCallback(
    (
      key: string,
      receiptId: string,
      generation: number,
      operationSignature: string,
    ) => {
      if (
        !mountedRef.current ||
        generationRef.current !== generation ||
        latestSignatureRef.current !== operationSignature ||
        effectSignatureRef.current !== operationSignature
      ) {
        return;
      }
      setStateEnvelope((current) => {
        const state = current.values[key];
        if (
          current.signature !== operationSignature ||
          !state ||
          !("receiptId" in state) ||
          state.receiptId !== receiptId ||
          !isTerminalState(state)
        ) {
          return current;
        }
        const values = { ...current.values };
        delete values[key];
        return { signature: current.signature, values };
      });
    },
    [],
  );

  const isContextCurrent = useCallback(
    (key: string, context: CancellationContext) =>
      mountedRef.current &&
      generationRef.current === context.generation &&
      latestSignatureRef.current === context.signature &&
      effectSignatureRef.current === context.signature &&
      contextsRef.current.get(key) === context,
    [],
  );

  const activateContext = useCallback(
    (
      resource: BillingSnapshotResource,
      handle: BillingCancelIntentHandle,
      generation: number,
      operationSignature: string,
      displayResource: BillingSnapshotResource = resource,
    ): CancellationContext => {
      const key = billingCancellationIdentityKey(displayResource);
      const current = contextsRef.current.get(key);
      if (
        current &&
        sameBoundContext(
          current,
          generation,
          operationSignature,
          handle,
          displayResource,
        )
      ) {
        return current;
      }

      clearTimer(key);
      const context = {
        generation,
        signature: operationSignature,
        receiptResource: resource,
        displayResource,
        handle,
        blocksNewerRevision:
          resource.cancellationControl.expectedLifecycleRevision !==
          displayResource.cancellationControl.expectedLifecycleRevision,
      };
      contextsRef.current.set(key, context);
      pollControlsRef.current.set(key, {
        context,
        nextSequence: 0,
        lastAppliedSequence: 0,
        terminal: false,
        inFlight: null,
      });
      return context;
    },
    [clearTimer],
  );

  const schedulePoll = useCallback(
    (context: CancellationContext, delayMs = pollIntervalMs) => {
      const key = billingCancellationIdentityKey(context.displayResource);
      clearTimer(key);
      const control = pollControlsRef.current.get(key);
      if (
        !isContextCurrent(key, context) ||
        !control ||
        control.context !== context ||
        control.terminal
      ) {
        return;
      }
      const timer = setTimeout(() => {
        timersRef.current.delete(key);
        void pollRef.current(context);
      }, delayMs);
      timersRef.current.set(key, timer);
    },
    [clearTimer, isContextCurrent, pollIntervalMs],
  );

  const applyReceipt = useCallback(
    async (
      context: CancellationContext,
      receipt: BillingCancellationReceipt,
      sequence?: number,
    ) => {
      const key = billingCancellationIdentityKey(context.displayResource);
      const control = pollControlsRef.current.get(key);
      if (
        !isContextCurrent(key, context) ||
        !control ||
        control.context !== context
      ) {
        return;
      }
      if (receipt.status === "accepted") {
        if (
          control.terminal ||
          (sequence !== undefined && sequence < control.lastAppliedSequence)
        ) {
          return;
        }
        if (sequence !== undefined) {
          control.lastAppliedSequence = sequence;
        }
        setState(
          key,
          { kind: "accepted", receiptId: receipt.receiptId },
          context.generation,
          context.signature,
        );
        schedulePoll(context);
        return;
      }

      control.terminal = true;
      if (sequence !== undefined) {
        control.lastAppliedSequence = Math.max(
          control.lastAppliedSequence,
          sequence,
        );
      }
      clearTimer(key);
      // A receipt is authoritative only for the lifecycle revision that
      // admitted it. When the snapshot already shows another revision, expose
      // refresh-and-review UI instead of claiming that the displayed resource
      // has stopped.
      const terminalState: ActiveComputeCancellationViewState =
        context.blocksNewerRevision || receipt.status === "conflict"
          ? { kind: "conflict", receiptId: receipt.receiptId }
          : receipt.status === "provider_confirmed"
            ? {
                kind: "provider_confirmed",
                receiptId: receipt.receiptId,
                computeStopped: true,
                providerStopped: true,
                retainedBackupBilling: receipt.retainedBackupBilling,
              }
            : { kind: "terminal_attention", receiptId: receipt.receiptId };
      setState(key, terminalState, context.generation, context.signature);
      try {
        await coordinator.clearTerminal({
          ...context.handle,
          receiptId: receipt.receiptId,
        });
      } catch {
        // The authoritative receipt remains visible. Failure to clear only
        // preserves the same idempotent intent for a future reconciliation.
      }
      let refreshed = false;
      if (isContextCurrent(key, context)) {
        try {
          refreshed = terminalRefreshSucceeded(await terminalRef.current());
        } catch {
          // The terminal receipt remains authoritative even when refreshing the
          // surrounding snapshot fails; that query already exposes stale/error UI.
        }
      }
      if (
        refreshed &&
        context.blocksNewerRevision &&
        isContextCurrent(key, context)
      ) {
        contextsRef.current.delete(key);
        pollControlsRef.current.delete(key);
        releaseState(
          key,
          receipt.receiptId,
          context.generation,
          context.signature,
        );
      }
    },
    [
      clearTimer,
      coordinator,
      isContextCurrent,
      releaseState,
      schedulePoll,
      setState,
    ],
  );

  pollRef.current = async (context) => {
    const { handle, receiptResource, displayResource, generation } = context;
    const key = billingCancellationIdentityKey(displayResource);
    const receiptId = handle.receiptId;
    const pollEndpoint = handle.pollEndpoint;
    const control = pollControlsRef.current.get(key);
    if (
      !receiptId ||
      !pollEndpoint ||
      !control ||
      control.context !== context ||
      control.terminal ||
      !isContextCurrent(key, context)
    ) {
      return;
    }
    clearTimer(key);
    if (control.inFlight) return control.inFlight;

    const sequence = control.nextSequence + 1;
    control.nextSequence = sequence;
    const operation = (async () => {
      try {
        const receipt = await withCancellationNetworkTimeout(
          networkTimeoutMs,
          (signal) =>
            readBillingCancellationReceipt(
              pollEndpoint,
              {
                resourceType: receiptResource.resourceType,
                resourceId: receiptResource.resourceId,
                expectedLifecycleRevision:
                  receiptResource.cancellationControl.expectedLifecycleRevision,
                receiptId,
              },
              signal,
            ),
        );
        await applyReceipt(context, receipt, sequence);
      } catch (error) {
        const currentControl = pollControlsRef.current.get(key);
        if (
          !isContextCurrent(key, context) ||
          currentControl !== control ||
          control.terminal ||
          sequence < control.lastAppliedSequence
        ) {
          return;
        }
        control.lastAppliedSequence = sequence;
        setState(
          key,
          { kind: "receipt_unavailable", receiptId },
          generation,
          context.signature,
        );
        if (isRetryableReceiptReadFailure(error)) {
          schedulePoll(
            context,
            error instanceof BillingCancellationHttpError &&
              error.retryAfterMs !== null
              ? Math.max(pollIntervalMs, error.retryAfterMs)
              : pollIntervalMs,
          );
        } else {
          clearTimer(key);
        }
      }
    })();
    control.inFlight = operation;
    void operation.then(
      () => {
        if (control.inFlight === operation) control.inFlight = null;
      },
      () => {
        if (control.inFlight === operation) control.inFlight = null;
      },
    );
    return operation;
  };

  useEffect(() => {
    effectSignatureRef.current = signature;
    mountedRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const resumableContexts = Array.from(pollControlsRef.current.values())
      .filter(
        (control) =>
          !control.terminal &&
          control.context.handle.receiptId !== null &&
          control.context.handle.pollEndpoint !== null,
      )
      .map((control) => control.context);
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
    contextsRef.current.clear();
    pollControlsRef.current.clear();
    setStateEnvelope({ signature, values: {} });

    for (const resource of resourcesRef.current ?? []) {
      const key = billingCancellationIdentityKey(resource);
      const resumableIndex = resumableContexts.findIndex(
        (context) =>
          context.handle.organizationId === organizationId &&
          context.handle.initiatedByUserId === initiatedByUserId &&
          context.handle.resourceType === resource.resourceType &&
          context.handle.resourceId === resource.resourceId,
      );
      if (resumableIndex >= 0) {
        const previous = resumableContexts.splice(resumableIndex, 1)[0];
        const context = activateContext(
          previous.receiptResource,
          previous.handle,
          generation,
          signature,
          resource,
        );
        setState(
          key,
          { kind: "accepted", receiptId: previous.handle.receiptId as string },
          generation,
          signature,
        );
        void pollRef.current(context);
        continue;
      }

      const identity = identityFor(organizationId, initiatedByUserId, resource);
      void (async () => {
        try {
          const bound = await coordinator.readBoundForResource(identity);
          if (
            !mountedRef.current ||
            generationRef.current !== generation ||
            latestSignatureRef.current !== signature ||
            effectSignatureRef.current !== signature
          ) {
            return;
          }
          if (bound) {
            const receiptResource = receiptResourceForHandle(resource, bound);
            if (!receiptResource) return;
            const context = activateContext(
              receiptResource,
              bound,
              generation,
              signature,
              resource,
            );
            setState(
              key,
              { kind: "accepted", receiptId: bound.receiptId },
              generation,
              signature,
            );
            void pollRef.current(context);
            return;
          }

          if (!resource.cancellationControl.eligible) return;
          const handle = await coordinator.readExact(identity);
          if (
            !handle ||
            !mountedRef.current ||
            generationRef.current !== generation ||
            latestSignatureRef.current !== signature ||
            effectSignatureRef.current !== signature
          ) {
            return;
          }
          if (handle.receiptId && handle.pollEndpoint) {
            const receiptResource = receiptResourceForHandle(resource, handle);
            if (!receiptResource) return;
            const context = activateContext(
              receiptResource,
              handle,
              generation,
              signature,
              resource,
            );
            setState(
              key,
              { kind: "accepted", receiptId: handle.receiptId },
              generation,
              signature,
            );
            void pollRef.current(context);
          } else {
            setState(key, { kind: "ambiguous" }, generation, signature);
          }
        } catch {
          if (resource.cancellationControl.eligible) {
            setState(key, { kind: "rejected" }, generation, signature);
          }
        }
      })();
    }

    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    };
  }, [
    activateContext,
    coordinator,
    initiatedByUserId,
    organizationId,
    setState,
    signature,
  ]);

  const request = useCallback(
    async (resource: BillingSnapshotResource) => {
      if (!resource.cancellationControl.eligible) return;
      const operationSignature = signature;
      const generation = generationRef.current;
      if (
        !mountedRef.current ||
        latestSignatureRef.current !== operationSignature ||
        effectSignatureRef.current !== operationSignature
      ) {
        return;
      }
      const key = billingCancellationIdentityKey(resource);
      const identity = identityFor(organizationId, initiatedByUserId, resource);
      setState(key, { kind: "submitting" }, generation, operationSignature);
      let networkAttempted = false;
      try {
        const alreadyBound = await coordinator.readBoundForResource(identity);
        if (
          !mountedRef.current ||
          generationRef.current !== generation ||
          latestSignatureRef.current !== operationSignature ||
          effectSignatureRef.current !== operationSignature
        ) {
          return;
        }
        if (alreadyBound) {
          const receiptResource = receiptResourceForHandle(
            resource,
            alreadyBound,
          );
          if (!receiptResource) return;
          const context = activateContext(
            receiptResource,
            alreadyBound,
            generation,
            operationSignature,
            resource,
          );
          setState(
            key,
            { kind: "accepted", receiptId: alreadyBound.receiptId },
            generation,
            operationSignature,
          );
          await pollRef.current(context);
          return;
        }

        const handle = await coordinator.reserve(identity);
        if (
          !mountedRef.current ||
          generationRef.current !== generation ||
          latestSignatureRef.current !== operationSignature ||
          effectSignatureRef.current !== operationSignature
        ) {
          return;
        }
        if (handle.receiptId && handle.pollEndpoint) {
          const receiptResource = receiptResourceForHandle(resource, handle);
          if (!receiptResource) return;
          const context = activateContext(
            receiptResource,
            handle,
            generation,
            operationSignature,
            resource,
          );
          setState(
            key,
            { kind: "accepted", receiptId: handle.receiptId },
            generation,
            operationSignature,
          );
          await pollRef.current(context);
          return;
        }

        networkAttempted = true;
        const result = await withCancellationNetworkTimeout(
          networkTimeoutMs,
          (signal) =>
            requestBillingCancellation({
              endpoint: resource.cancellationControl.endpoint,
              resourceType: resource.resourceType,
              resourceId: resource.resourceId,
              expectedLifecycleRevision:
                resource.cancellationControl.expectedLifecycleRevision,
              idempotencyKey: handle.idempotencyKey,
              signal,
            }),
        );
        const binding = await coordinator.bindReceipt({
          ...handle,
          receiptId: result.receipt.receiptId,
          pollEndpoint: result.receipt.pollEndpoint,
        });
        const operationIsStale =
          !mountedRef.current ||
          generationRef.current !== generation ||
          latestSignatureRef.current !== operationSignature ||
          effectSignatureRef.current !== operationSignature;
        if (operationIsStale) {
          reconcileLateBoundReceipt(
            organizationId,
            initiatedByUserId,
            resource.resourceType,
            resource.resourceId,
          );
          if (
            mountedRef.current &&
            result.receipt.status !== "accepted" &&
            principalRef.current.organizationId === organizationId &&
            principalRef.current.initiatedByUserId === initiatedByUserId
          ) {
            try {
              await terminalRef.current();
            } catch {
              // A later reconciliation still owns the visible refresh state.
            }
          }
          return;
        }
        if (binding.status === "superseded") {
          let currentlyBound: BillingCancelBoundIntentHandle | null = null;
          try {
            currentlyBound = await coordinator.readBoundForResource(identity);
          } catch {
            // A storage failure cannot invalidate the strict server receipt
            // already returned for this command.
          }
          if (
            !mountedRef.current ||
            generationRef.current !== generation ||
            latestSignatureRef.current !== operationSignature ||
            effectSignatureRef.current !== operationSignature
          ) {
            reconcileLateBoundReceipt(
              organizationId,
              initiatedByUserId,
              resource.resourceType,
              resource.resourceId,
            );
            return;
          }

          const boundMatchesResult =
            currentlyBound?.receiptId === result.receipt.receiptId &&
            currentlyBound.pollEndpoint === result.receipt.pollEndpoint &&
            currentlyBound.resourceType === result.receipt.resourceType &&
            currentlyBound.resourceId === result.receipt.resourceId &&
            currentlyBound.expectedLifecycleRevision ===
              result.receipt.expectedLifecycleRevision;
          if (currentlyBound && !boundMatchesResult) {
            const receiptResource = receiptResourceForHandle(
              resource,
              currentlyBound,
            );
            if (!receiptResource) return;
            const context = activateContext(
              receiptResource,
              currentlyBound,
              generation,
              operationSignature,
              resource,
            );
            setState(
              key,
              { kind: "accepted", receiptId: currentlyBound.receiptId },
              generation,
              operationSignature,
            );
            await pollRef.current(context);
            return;
          }

          // The browser CAS may be superseded by another tab, but the strict
          // server receipt remains pollable in memory. A terminal result is
          // projected as a conflict unless the durable slot still proves that
          // this exact lifecycle owns the resource.
          const resultHandle: BillingCancelIntentHandle = {
            ...handle,
            receiptId: result.receipt.receiptId,
            pollEndpoint: result.receipt.pollEndpoint,
          };
          const receiptResource = receiptResourceForHandle(
            resource,
            resultHandle,
          );
          if (!receiptResource) return;
          const context = activateContext(
            receiptResource,
            resultHandle,
            generation,
            operationSignature,
            resource,
          );
          if (
            result.receipt.status !== "accepted" &&
            !currentlyBound &&
            result.disposition !== "same_key_replay"
          ) {
            context.blocksNewerRevision = true;
          }
          await applyReceipt(context, result.receipt);
          return;
        }
        const context = activateContext(
          resource,
          binding.intent,
          generation,
          operationSignature,
        );
        await applyReceipt(context, result.receipt);
      } catch (error) {
        if (
          !mountedRef.current ||
          generationRef.current !== generation ||
          latestSignatureRef.current !== operationSignature ||
          effectSignatureRef.current !== operationSignature
        ) {
          return;
        }
        if (
          error instanceof BillingCancellationHttpError &&
          error.status === 409
        ) {
          setState(key, { kind: "conflict" }, generation, operationSignature);
          try {
            await terminalRef.current();
          } catch {
            // The conflict remains visible while the snapshot owns refresh UI.
          }
          return;
        }
        if (
          error instanceof BillingCancellationHttpError &&
          [400, 401, 403, 404, 422].includes(error.status)
        ) {
          setState(key, { kind: "rejected" }, generation, operationSignature);
          try {
            await terminalRef.current();
          } catch {
            // The rejection remains visible while the snapshot owns refresh UI.
          }
          return;
        }
        setState(
          key,
          { kind: networkAttempted ? "ambiguous" : "rejected" },
          generation,
          operationSignature,
        );
      }
    },
    [
      activateContext,
      applyReceipt,
      coordinator,
      initiatedByUserId,
      networkTimeoutMs,
      organizationId,
      reconcileLateBoundReceipt,
      setState,
      signature,
    ],
  );

  const checkReceipt = useCallback(
    async (resource: BillingSnapshotResource) => {
      const context = contextsRef.current.get(
        billingCancellationIdentityKey(resource),
      );
      if (context) await pollRef.current(context);
    },
    [],
  );

  const states =
    stateEnvelope.signature === signature
      ? stateEnvelope.values
      : EMPTY_CANCELLATION_STATES;

  return { states, request, checkReceipt };
}
