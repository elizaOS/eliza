/** Coordinates local delegated admission with durable primary effect receipts. */

import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import type { InferenceBudgetPolicy } from "@elizaos/cloud-shared/lib/services/inference-funded-budget-admission";
import type { InferenceFundingBudgetConsumption } from "@elizaos/cloud-shared/lib/services/inference-funding-budget-protocol";
import {
  budgetConsumptionPayload,
  budgetSealPayload,
  signBudgetEffect,
  verifyBudgetEffect,
} from "@elizaos/cloud-shared/lib/services/inference-funding-budget-protocol";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import {
  InferenceAdmissionBudget,
  InferenceBudgetError,
  type InferenceBudgetReceipt,
  type InferenceBudgetRefill,
  type InferenceBudgetRequest,
} from "./inference-admission-budget";

export interface FundedBudgetCallbacks {
  withAuthority<T>(operation: () => Promise<T>): Promise<T>;
  checkCredential(credential: unknown): Promise<Response | null>;
  consumeRate(request: unknown): Promise<Response>;
}
interface PolicyState {
  organizationId: string;
  policy?: InferenceBudgetPolicy;
  pendingMutationIds: string[];
  cutoverAt: number;
}
interface Mutation {
  mutationId: string;
  fenceToken: string;
  validUntil: number;
  resolved?: boolean;
  rateWindowEndsAt?: number;
}
interface Credential {
  organizationId?: string;
  kind: "api_key" | "session";
  credentialId: string;
  userId: string;
  rateLimit?: number;
  expiresAt?: number | null;
  issuedAt?: number;
}
interface Admission extends InferenceBudgetRequest {
  organizationId: string;
  credential: Credential;
  endpointType: string;
  rateReceipt?: string;
}
interface RateReceipt {
  token: string;
  epoch: string;
  generation: string;
  credential: string;
  endpointType: string;
}
const POLICY = "funded-budget:policy";
const mutationKey = (id: string) => `funded-budget:mutation:${id}`;
const rateKey = (id: string) => `funded-budget:rate:${id}`;
const error = (message: string, status = 503) =>
  Response.json(
    {
      error: {
        message,
        type: status === 402 ? "insufficient_quota" : "service_unavailable",
        code:
          status === 402
            ? "insufficient_quota"
            : "inference_budget_unavailable",
      },
    },
    { status },
  );
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const credentialIdentity = (c: Credential) =>
  JSON.stringify([
    c.kind,
    c.credentialId,
    c.userId,
    c.rateLimit ?? null,
    c.expiresAt ?? null,
    c.issuedAt ?? null,
  ]);

export class InferenceFundedBudgetController {
  private readonly refills = new Map<
    string,
    Promise<
      Awaited<
        ReturnType<
          typeof import("@elizaos/cloud-shared/db/repositories/inference-funding-budgets").reserveBudget
        >
      >
    >
  >();
  private policyLoad: Promise<InferenceBudgetPolicy> | undefined;
  private draining: Promise<void> | undefined;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: Record<string, unknown>,
    private readonly callbacks: FundedBudgetCallbacks,
  ) {}

  private async primary<T>(operation: () => Promise<T>): Promise<T> {
    return runWithCloudBindingsAsync(this.env, async () => {
      const { runWithDbCacheAsync } = await import(
        "@elizaos/cloud-shared/db/client"
      );
      return runWithDbCacheAsync(operation);
    });
  }
  private async state(organizationId: string): Promise<PolicyState> {
    return this.storage.transaction(async (tx) => {
      const state = await tx.get<PolicyState>(POLICY);
      if (state && state.organizationId !== organizationId)
        throw new InferenceBudgetError(
          "BUDGET_REPLAY_CONFLICT",
          "Controller belongs to another organization",
        );
      if (state) {
        if (state.cutoverAt === undefined) {
          state.cutoverAt = (Math.floor(Date.now() / 60000) + 1) * 60000;
          await tx.put(POLICY, state);
        }
        return state;
      }
      const initial: PolicyState = {
        organizationId,
        pendingMutationIds: [],
        cutoverAt: (Math.floor(Date.now() / 60000) + 1) * 60000,
      };
      await tx.put(POLICY, initial);
      return initial;
    });
  }

  private secret(): string {
    const secret = this.env.INFERENCE_FUNDING_BUDGET_SEAL_SECRET;
    if (
      typeof secret !== "string" ||
      new TextEncoder().encode(secret).length < 32
    )
      throw new InferenceBudgetError(
        "BUDGET_NOT_READY",
        "Budget signing secret is unavailable",
      );
    return secret;
  }
  private async schedule(at: number): Promise<void> {
    const current = await this.storage.getAlarm();
    const next = Math.max(Date.now() + 1, at);
    if (current === null || next < current) await this.storage.setAlarm(next);
  }
  private async policy(organizationId: string): Promise<void> {
    const state = await this.callbacks.withAuthority(() =>
      this.state(organizationId),
    );
    if (state.pendingMutationIds.length > 0)
      throw new InferenceBudgetError(
        "BUDGET_NOT_READY",
        "Inference policy mutation is pending",
      );
    if (state.policy && state.policy.validUntil > Date.now()) return;
    this.policyLoad ??= this.primary(async () => {
      const { loadInferenceBudgetPolicy } = await import(
        "@elizaos/cloud-shared/lib/services/inference-funded-budget-admission"
      );
      return loadInferenceBudgetPolicy(organizationId);
    }).finally(() => {
      this.policyLoad = undefined;
    });
    const policy = await this.policyLoad;
    await this.callbacks.withAuthority(async () => {
      const state = await this.state(organizationId);
      if (state.pendingMutationIds.length !== 0)
        throw new InferenceBudgetError(
          "BUDGET_NOT_READY",
          "Policy changed during hydration",
        );
      if (!state.policy || BigInt(policy.epoch) >= BigInt(state.policy.epoch))
        state.policy = policy;
      await this.storage.put(POLICY, state);
    });
  }
  private async authorized(
    input: Admission,
  ): Promise<InferenceBudgetPolicy | Response> {
    const state = await this.state(input.organizationId);
    const policy = state.policy;
    if (state.cutoverAt > Date.now())
      return error("Rate counter cutover is pending");
    if (
      state.pendingMutationIds.length !== 0 ||
      !policy ||
      policy.enabled !== true ||
      policy.organizationId !== input.organizationId ||
      policy.validUntil <= Date.now()
    )
      return error("Inference policy is not ready");
    if (
      input.policyEpoch !== policy.epoch ||
      input.policyGeneration !== policy.policyGeneration
    )
      return error("Credential policy proof is stale");
    if (
      input.credential.organizationId !== undefined &&
      input.credential.organizationId !== input.organizationId
    )
      return error("Credential belongs to another organization", 400);
    if (
      input.credential.expiresAt !== undefined &&
      input.credential.expiresAt !== null &&
      input.credential.expiresAt <= Date.now()
    )
      return error("Credential expired", 403);
    return (
      (await this.callbacks.checkCredential({
        ...input.credential,
        organizationId: input.organizationId,
      })) ?? policy
    );
  }
  private async rate(
    input: Admission,
    policy: InferenceBudgetPolicy,
  ): Promise<Response | RateReceipt> {
    const existing = await this.storage.get<RateReceipt>(
      rateKey(input.requestId),
    );
    const identity = credentialIdentity(input.credential);
    if (existing) {
      if (
        existing.epoch !== policy.epoch ||
        existing.generation !== policy.policyGeneration ||
        existing.credential !== identity ||
        existing.endpointType !== input.endpointType
      )
        return error("Rate receipt belongs to another request policy");
      return existing;
    }
    if (input.rateReceipt !== undefined)
      return error("Rate receipt is missing");
    const maximum =
      input.endpointType === "embeddings"
        ? policy.rateLimits.embeddingsRpm
        : input.endpointType === "completions"
          ? policy.rateLimits.completionsRpm
          : input.endpointType === "strict"
            ? policy.rateLimits.strictRpm
            : policy.rateLimits.standardRpm;
    const intentKey = `funded-budget:rate-intent:${input.requestId}`;
    let intent = await this.storage.get<{
      epoch: string;
      credential: string;
      endpointType: string;
      operationDeadlineAt: number;
    }>(intentKey);
    if (!intent) {
      intent = {
        epoch: policy.epoch,
        credential: identity,
        endpointType: input.endpointType,
        operationDeadlineAt: Date.now() + 3000,
      };
      await this.storage.put(intentKey, intent);
    }
    if (
      intent.epoch !== policy.epoch ||
      intent.credential !== identity ||
      intent.endpointType !== input.endpointType
    )
      return error("Rate intent belongs to another credential policy");
    const response = await this.callbacks.consumeRate({
      ...input,
      windowMs: 60000,
      maxRequests: maximum,
      operationId: input.requestId,
      operationDeadlineAt: intent.operationDeadlineAt,
      credentialLimit: input.credential.rateLimit,
    });
    if (!response.ok) return response;
    const receipt: RateReceipt = {
      token: crypto.randomUUID(),
      epoch: policy.epoch,
      generation: policy.policyGeneration,
      credential: identity,
      endpointType: input.endpointType,
    };
    await this.storage.put(rateKey(input.requestId), receipt);
    return receipt;
  }
  private async mint(organizationId: string, refill: InferenceBudgetRefill) {
    let pending = this.refills.get(refill.id);
    if (!pending) {
      pending = (async () => {
        const key = `funded-budget:mint:${refill.id}`;
        let request =
          await this.storage.get<
            Parameters<
              typeof import("@elizaos/cloud-shared/db/repositories/inference-funding-budgets").reserveBudget
            >[0]
          >(key);
        if (!request) {
          const policy = (await this.state(organizationId)).policy;
          const deadline = Math.min(
            policy?.validUntil ?? Date.UTC(9999, 11, 31),
            Date.UTC(9999, 11, 31),
          );
          request = {
            organizationId,
            grantId: refill.id,
            minimumMicros: refill.minimumMicros,
            targetMicros:
              BigInt(refill.minimumMicros) > 1000000n
                ? refill.minimumMicros
                : "1000000",
            policyGeneration: refill.policyGeneration,
            policyEpoch: refill.policyEpoch,
            ttlMs: Math.max(1, deadline - Date.now()),
          };
          await this.storage.put(key, request);
        }
        await this.schedule(Date.now() + 1000);
        return this.primary(async () => {
          const { reserveBudget } = await import(
            "@elizaos/cloud-shared/db/repositories/inference-funding-budgets"
          );
          return reserveBudget(request);
        });
      })().finally(() => {
        this.refills.delete(refill.id);
      });
      this.refills.set(refill.id, pending);
    }
    return pending;
  }
  private async admit(input: Admission): Promise<Response> {
    await this.policy(input.organizationId);
    await this.schedule(Date.now() + 1000);
    const budget = new InferenceAdmissionBudget(
      this.storage,
      input.organizationId,
    );
    for (;;) {
      const decision = await this.callbacks.withAuthority(async () => {
        const policy = await this.authorized(input);
        if (policy instanceof Response) return policy;
        const rate = await this.rate(input, policy);
        if (rate instanceof Response) return rate;
        if (input.rateReceipt !== undefined && rate.token !== input.rateReceipt)
          return error("Rate acknowledgement does not match its receipt");
        const result = await budget.reserve({
          requestId: input.requestId,
          maximumMicros: input.maximumMicros,
          unknownCostMicros: input.unknownCostMicros,
          policyGeneration: input.policyGeneration,
          policyEpoch: input.policyEpoch,
          preProviderCancellationToken: input.preProviderCancellationToken,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          recovery: input.recovery,
        });
        if (result.kind === "RESERVED") {
          await this.schedule(input.expiresAt);
          return Response.json({
            admitted: true,
            budget: true,
            requestId: input.requestId,
            maximumMicros: input.maximumMicros,
            rateReceipt: rate.token,
          });
        }
        if (result.kind === "COMPLETED")
          return Response.json({
            admitted: false,
            completed: true,
            receipt: result.receipt,
          });
        return result;
      });
      if (decision instanceof Response) return decision;
      await this.closeIdle(input.organizationId);
      const minted = await this.mint(input.organizationId, decision.refill);
      if (minted.status === "granted") {
        await this.callbacks.withAuthority(() =>
          budget.installGrant(minted.grant),
        );
        await this.schedule(minted.grant.expiresAt);
        continue;
      }
      if (minted.status === "fenced") {
        await this.callbacks.withAuthority(() =>
          budget.rejectRefill(decision.refill.id),
        );
        return error(
          "Inference budget funding policy changed; retry authorization",
        );
      }
      const insufficient = await this.callbacks.withAuthority(async () => {
        const policy = await this.authorized(input);
        if (policy instanceof Response) return policy;
        const retry = await budget.reserve(input);
        if (retry.kind !== "NEEDS_REFILL") return false;
        const owns =
          retry.refill.id === decision.refill.id &&
          retry.refill.ownerRequestId === input.requestId &&
          retry.shortfallMicros === decision.refill.minimumMicros;
        if ((await budget.readPendingRefill())?.id === decision.refill.id)
          await budget.rejectRefill(decision.refill.id);
        return owns
          ? {
              availableMicros: (
                BigInt(input.maximumMicros) -
                BigInt(retry.shortfallMicros) +
                BigInt(minted.availableMicros)
              ).toString(),
            }
          : false;
      });
      if (insufficient instanceof Response) return insufficient;
      if (insufficient)
        return Response.json(
          {
            error: {
              message: "Authoritative funds cannot cover this request",
              type: "insufficient_quota",
              code: "insufficient_quota",
            },
            requiredMicros: input.maximumMicros,
            availableMicros: insufficient.availableMicros,
          },
          { status: 402 },
        );
    }
  }
  private async signed(
    budget: InferenceAdmissionBudget,
    receipt: InferenceBudgetReceipt,
  ): Promise<InferenceFundingBudgetConsumption> {
    const request = await budget.readRequest(receipt.requestId);
    if (!request)
      throw new InferenceBudgetError(
        "BUDGET_REPLAY_CONFLICT",
        "Receipt lost its recovery context",
      );
    const recovered = await this.storage.get<boolean>(
      `funded-budget:recovered:${receipt.requestId}`,
    );
    const metadata = {
      ...(recovered ? { recovered: true, uncertain: true } : {}),
      ...(request.recovery.metadata ?? {}),
      requestId: request.requestId,
      userId: request.recovery.userId,
      model: request.recovery.model,
      provider: request.recovery.provider,
      billingSource: request.recovery.billingSource,
      admission: "durable_object_escrow",
      ...(request.recovery.kind === "organization" &&
      request.recovery.accounting.kind === "subscription_funding" &&
      request.recovery.accounting.affiliate
        ? {
            affiliatePayout: {
              version: 1,
              sourceId: request.recovery.accounting.affiliate.payoutSourceId,
              attribution: request.recovery.accounting.affiliate.attribution,
              model: request.recovery.model,
            },
          }
        : {}),
    };
    const unsigned = { ...receipt, metadata };
    return {
      ...unsigned,
      signature: await signBudgetEffect(
        budgetConsumptionPayload(unsigned),
        this.secret(),
      ),
    };
  }
  private async closeIdle(
    organizationId: string,
    force = false,
  ): Promise<void> {
    const budget = new InferenceAdmissionBudget(this.storage, organizationId);
    await this.callbacks.withAuthority(async () => {
      const state = await this.state(organizationId);
      for (const grant of await budget.readGrants())
        if (
          grant.activeLeaseCount === 0 &&
          grant.unacknowledgedReceiptCount === 0 &&
          (force ||
            grant.expiresAt <= Date.now() ||
            grant.remainingMicros === "0" ||
            grant.policyGeneration !== state.policy?.policyGeneration)
        )
          await budget.sealGrant(grant.id);
    });
    let startAfter: string | undefined;
    for (;;) {
      const page = await budget.pendingSeals({ limit: 100, startAfter });
      if (page.size === 0) break;
      for (const [key, proof] of page) {
        const signed = {
          ...proof,
          signature: await signBudgetEffect(
            budgetSealPayload(proof),
            this.secret(),
          ),
        };
        await this.primary(async () => {
          const { closeBudget } = await import(
            "@elizaos/cloud-shared/db/repositories/inference-funding-budgets"
          );
          await closeBudget(signed);
        });
        await this.callbacks.withAuthority(() => budget.acknowledgeSeal(proof));
        startAfter = key;
      }
    }
  }
  private async drain(organizationId: string): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      const budget = new InferenceAdmissionBudget(this.storage, organizationId);
      const pending: InferenceBudgetReceipt[] = [];
      let startAfter: string | undefined;
      for (;;) {
        const page = await budget.pendingReceipts({ limit: 100, startAfter });
        if (page.size === 0) break;
        for (const [key, receipt] of page) {
          pending.push(receipt);
          startAfter = key;
        }
      }
      // A receipt can reference several grants. Only advance each grant's contiguous prefix.
      let remaining = pending;
      let failure: unknown;
      while (remaining.length) {
        const retry: InferenceBudgetReceipt[] = [];
        let progressed = false;
        for (const receipt of remaining) {
          try {
            const signed = await this.signed(budget, receipt);
            await this.primary(async () => {
              const { recordConsumption } = await import(
                "@elizaos/cloud-shared/db/repositories/inference-funding-budgets"
              );
              await recordConsumption(signed);
            });
            await this.callbacks.withAuthority(() =>
              budget.acknowledge(receipt),
            );
            progressed = true;
          } catch (cause) {
            failure = cause;
            retry.push(receipt);
          }
        }
        if (!progressed) throw failure;
        remaining = retry;
      }
      await this.closeIdle(organizationId);
    })().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }
  private async authoritativeRate(
    body: Record<string, unknown>,
    organizationId: string,
  ): Promise<Response> {
    const {
      requestId,
      policyEpoch,
      policyGeneration,
      endpointType,
      keyId,
      keyLimit,
      windowStartedAt,
      signature,
    } = body;
    if (
      !id(requestId) ||
      !id(policyEpoch) ||
      !id(policyGeneration) ||
      !id(endpointType) ||
      typeof signature !== "string" ||
      !Number.isSafeInteger(windowStartedAt) ||
      !(keyId === null || id(keyId)) ||
      !(
        keyLimit === null ||
        (Number.isSafeInteger(keyLimit) && Number(keyLimit) > 0)
      ) ||
      (keyId === null) !== (keyLimit === null)
    )
      return error("Invalid primary rate proof", 400);
    const payload = JSON.stringify([
      "inference-budget-primary-rate-v1",
      organizationId,
      requestId,
      policyEpoch,
      policyGeneration,
      endpointType,
      keyId,
      keyLimit,
      windowStartedAt,
    ]);
    if (!(await verifyBudgetEffect(payload, signature, this.secret())))
      return error("Invalid primary rate signature", 400);
    await this.policy(organizationId);
    return this.callbacks.withAuthority(async () => {
      const state = await this.state(organizationId);
      const policy = state.policy;
      if (
        state.cutoverAt > Date.now() ||
        state.pendingMutationIds.length ||
        !policy ||
        policy.validUntil <= Date.now() ||
        policy.epoch !== policyEpoch ||
        policy.policyGeneration !== policyGeneration
      )
        return error("Primary rate policy proof is stale or pending");
      const intentKey = `funded-budget:primary-rate:${requestId}`;
      let intent = await this.storage.get<{
        payload: string;
        deadline: number;
      }>(intentKey);
      if (!intent) {
        intent = { payload, deadline: Date.now() + 3000 };
        await this.storage.put(intentKey, intent);
      }
      if (intent.payload !== payload)
        return error("Primary rate replay changes its proof", 400);
      const maxRequests =
        endpointType === "completions"
          ? policy.rateLimits.completionsRpm
          : endpointType === "embeddings"
            ? policy.rateLimits.embeddingsRpm
            : endpointType === "strict"
              ? policy.rateLimits.strictRpm
              : policy.rateLimits.standardRpm;
      return this.callbacks.consumeRate({
        organizationId,
        requestId,
        operationId: requestId,
        operationDeadlineAt: intent.deadline,
        endpointType,
        windowMs: 60000,
        windowStartedAt,
        maxRequests,
        ...(keyId !== null
          ? { credential: { credentialId: keyId }, credentialLimit: keyLimit }
          : {}),
      });
    });
  }

  private async begin(
    organizationId: string,
    mutationId: string,
    disable = false,
  ): Promise<Response> {
    return this.callbacks.withAuthority(async () => {
      const state = await this.state(organizationId);
      const key = mutationKey(mutationId);
      let mutation = await this.storage.get<Mutation>(key);
      if (!mutation) {
        const now = Date.now();
        const rateWindowEndsAt = disable
          ? (Math.floor(now / 60000) + 1) * 60000
          : undefined;
        mutation = {
          mutationId,
          fenceToken: crypto.randomUUID(),
          validUntil: (rateWindowEndsAt ?? now) + 30000,
          ...(rateWindowEndsAt !== undefined ? { rateWindowEndsAt } : {}),
        };
        state.pendingMutationIds.push(mutationId);
        const pending = mutation;
        // A durable denial must always retain its recovery wakeup, including
        // a crash before the primary transaction records the permit.
        await this.storage.transaction(async (tx) => {
          const alarm = await tx.getAlarm();
          await tx.put({ [POLICY]: state, [key]: pending });
          const next = Math.max(Date.now() + 1, pending.validUntil);
          await tx.setAlarm(alarm === null ? next : Math.min(alarm, next));
        });
      }
      if (disable !== (mutation.rateWindowEndsAt !== undefined))
        return error("Mutation retry changes its rollback intent", 400);
      await this.schedule(mutation.validUntil);
      return Response.json({ blocked: true, ...mutation });
    });
  }
  private async resolve(
    organizationId: string,
    mutationId: string,
    token?: string,
  ): Promise<void> {
    const mutation = await this.storage.get<Mutation>(mutationKey(mutationId));
    if (!mutation || mutation.resolved) return;
    if (token !== undefined && token !== mutation.fenceToken)
      throw new InferenceBudgetError(
        "BUDGET_REPLAY_CONFLICT",
        "Policy acknowledgement token differs",
      );
    const observed = await this.primary(async () => {
      const { inspectInferencePolicyMutation } = await import(
        "@elizaos/cloud-shared/lib/services/inference-policy-fence"
      );
      return inspectInferencePolicyMutation(organizationId, mutationId);
    });
    if (observed.state === "absent" && mutation.validUntil > Date.now())
      throw new InferenceBudgetError(
        "BUDGET_NOT_READY",
        "Policy transaction is still permitted",
      );
    if (
      observed.state !== "absent" &&
      observed.fenceToken !== mutation.fenceToken
    )
      throw new InferenceBudgetError(
        "BUDGET_REPLAY_CONFLICT",
        "Primary policy fence differs",
      );
    const policy = await this.primary(async () => {
      const { loadInferenceBudgetPolicy } = await import(
        "@elizaos/cloud-shared/lib/services/inference-funded-budget-admission"
      );
      return loadInferenceBudgetPolicy(organizationId);
    });
    if (
      observed.state !== "absent" &&
      BigInt(policy.epoch) < BigInt(observed.epoch)
    )
      throw new InferenceBudgetError(
        "BUDGET_NOT_READY",
        "Policy publication is behind its committed mutation",
      );
    await this.callbacks.withAuthority(async () => {
      const state = await this.state(organizationId);
      if (!state.policy || BigInt(policy.epoch) >= BigInt(state.policy.epoch))
        state.policy = policy;
      state.pendingMutationIds = state.pendingMutationIds.filter(
        (id) => id !== mutationId,
      );
      await this.storage.put({
        [POLICY]: state,
        [mutationKey(mutationId)]: { ...mutation, resolved: true },
      });
    });
  }
  async handle(path: string, body: unknown): Promise<Response> {
    if (!record(body) || !id(body.organizationId))
      return error("Invalid budget organization", 400);
    const organizationId = body.organizationId;
    try {
      if (path === "/policy-mutation/begin" && id(body.mutationId))
        return this.begin(
          organizationId,
          body.mutationId,
          body.disable === true,
        );
      if (
        path === "/policy-mutation/disable-ready" &&
        id(body.mutationId) &&
        id(body.fenceToken)
      ) {
        return this.callbacks.withAuthority(async () => {
          const state = await this.state(organizationId);
          const mutation = await this.storage.get<Mutation>(
            mutationKey(body.mutationId as string),
          );
          if (
            !mutation ||
            mutation.resolved ||
            mutation.fenceToken !== body.fenceToken ||
            mutation.rateWindowEndsAt === undefined ||
            !state.pendingMutationIds.includes(mutation.mutationId)
          )
            return error("Rollback fence is unavailable", 400);
          return Response.json({
            ready:
              Date.now() >= mutation.rateWindowEndsAt &&
              Date.now() < mutation.validUntil,
            rateWindowEndsAt: mutation.rateWindowEndsAt,
          });
        });
      }
      if (
        path === "/policy-mutation/commit" &&
        id(body.mutationId) &&
        id(body.fenceToken)
      ) {
        await this.resolve(organizationId, body.mutationId, body.fenceToken);
        return Response.json({ committed: true });
      }
      if (path === "/budget/authoritative-rate")
        return await this.authoritativeRate(body, organizationId);
      if (path === "/budget/reclaim") {
        await this.drain(organizationId);
        await this.closeIdle(organizationId, true);
        const budget = new InferenceAdmissionBudget(
          this.storage,
          organizationId,
        );
        const pending = (await budget.readGrants()).some(
          (grant) =>
            grant.remainingMicros !== "0" &&
            (grant.activeLeaseCount > 0 ||
              grant.unacknowledgedReceiptCount > 0),
        );
        return Response.json({ released: true, pending });
      }
      const budget = new InferenceAdmissionBudget(this.storage, organizationId);
      if (path === "/budget/acknowledge" && record(body.receipt)) {
        const receipt =
          body.receipt as unknown as InferenceFundingBudgetConsumption;
        if (
          !(await verifyBudgetEffect(
            budgetConsumptionPayload(receipt),
            receipt.signature,
            this.secret(),
          ))
        )
          return error("Budget receipt signature is invalid", 400);
        const { signature: _signature, metadata: _metadata, ...bare } = receipt;
        await this.callbacks.withAuthority(() => budget.acknowledge(bare));
        return Response.json({ acknowledged: true });
      }
      if (
        path === "/budget/complete" &&
        id(body.requestId) &&
        typeof body.amountMicros === "string"
      ) {
        const receipt = await this.callbacks.withAuthority(() =>
          budget.complete(
            body.requestId as string,
            body.amountMicros as string,
          ),
        );
        await this.schedule(Date.now() + 1000);
        return Response.json({ receipt: await this.signed(budget, receipt) });
      }
      if (
        path === "/budget/cancel" &&
        id(body.requestId) &&
        id(body.preProviderCancellationToken)
      ) {
        const receipt = await this.callbacks.withAuthority(() =>
          budget.cancel(
            body.requestId as string,
            body.preProviderCancellationToken as string,
          ),
        );
        await this.schedule(Date.now() + 1000);
        return Response.json({ receipt: await this.signed(budget, receipt) });
      }
      if (path === "/budget/admit" || path === "/budget/rate") {
        if (
          !id(body.requestId) ||
          !record(body.credential) ||
          !id(body.policyEpoch) ||
          !id(body.policyGeneration) ||
          !id(body.endpointType)
        )
          return error("Invalid budget credential policy proof", 400);
        const input = body as unknown as Admission;
        if (path === "/budget/admit") return await this.admit(input);
        await this.policy(organizationId);
        return this.callbacks.withAuthority(async () => {
          const policy = await this.authorized(input);
          if (policy instanceof Response) return policy;
          const rate = await this.rate(input, policy);
          return rate instanceof Response
            ? rate
            : Response.json({ allowed: true, rateReceipt: rate.token });
        });
      }
      return error("Invalid budget operation", 400);
    } catch (cause) {
      await this.schedule(Date.now() + 1000);
      if (cause instanceof InferenceBudgetError)
        return error(
          cause.message,
          cause.code === "INVALID_BUDGET_INPUT" ? 400 : 503,
        );
      logger.error("[InferenceBudget] operation failed", {
        path,
        organizationId,
        errorName: cause instanceof Error ? cause.name : "UnknownError",
      });
      return error("Inference budget primary operation is unavailable");
    }
  }
  async alarm(): Promise<void> {
    const state = await this.storage.get<PolicyState>(POLICY);
    if (!state) return;
    try {
      for (const mutationId of state.pendingMutationIds) {
        const mutation = await this.storage.get<Mutation>(
          mutationKey(mutationId),
        );
        if (mutation && mutation.validUntil <= Date.now())
          await this.resolve(state.organizationId, mutationId);
        else if (mutation) await this.schedule(mutation.validUntil);
      }
      const budget = new InferenceAdmissionBudget(
        this.storage,
        state.organizationId,
      );
      const refill = await budget.readPendingRefill();
      if (refill) {
        const minted = await this.mint(state.organizationId, refill);
        await this.callbacks.withAuthority(async () => {
          if (minted.status === "granted")
            await budget.installGrant(minted.grant);
          else await budget.rejectRefill(refill.id);
        });
        await this.closeIdle(state.organizationId, true);
      }
      let startAfter: string | undefined;
      for (;;) {
        const page = await budget.requests({ limit: 100, startAfter });
        if (page.size === 0) break;
        for (const [key, snapshot] of page) {
          startAfter = key;
          if (snapshot.receipt) continue;
          if (snapshot.expiresAt > Date.now()) {
            await this.schedule(snapshot.expiresAt);
            continue;
          }
          await this.callbacks.withAuthority(async () => {
            const request = await budget.readRequest(snapshot.requestId);
            if (!request || request.receipt) return;
            await this.storage.put(
              `funded-budget:recovered:${request.requestId}`,
              true,
            );
            await budget.complete(request.requestId, request.unknownCostMicros);
          });
        }
      }
      await this.drain(state.organizationId);
      for (const grant of await budget.readGrants())
        await this.schedule(grant.expiresAt);
    } catch (cause) {
      await this.schedule(Date.now() + 1000);
      throw cause;
    }
  }
}
