import { createHash } from "node:crypto";
import { NativeCloudServiceError } from "./errors.mjs";

const fail = (status = 502) => {
  throw new NativeCloudServiceError("Plan-change information is unavailable", {
    status,
  });
};
const id = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const revision = (v) =>
  typeof v === "string" &&
  /^[1-9][0-9]*$/.test(v) &&
  Number.isSafeInteger(Number(v));
const date = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) &&
  Number.isFinite(Date.parse(v));
const amount = (v) => typeof v === "string" && /^(0|[1-9]\d*)\.\d{6}$/.test(v);
const cursor = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,1024}$/.test(v);
const kind = (v) => v === "upgrade" || v === "downgrade";
const pick = (v, fields) => Object.fromEntries(fields.map((k) => [k, v[k]]));
const common = [
  "commandId",
  "subscriptionId",
  "targetPlanKey",
  "status",
  "expectedSubscriptionRevision",
];
function commandBase(v, policy) {
  if (
    !v ||
    !id(v.commandId) ||
    !id(v.subscriptionId) ||
    !policy.planKeys.includes(v.targetPlanKey) ||
    !revision(v.expectedSubscriptionRevision) ||
    ![
      "PREPARED",
      "OUTCOME_UNKNOWN",
      "APPLIED",
      "FAILED",
      "SUPERSEDED",
    ].includes(v.status)
  )
    fail();
  return pick(v, common);
}
export function projectPlanChangeCommand(v, action, policy) {
  const base = commandBase(v, policy);
  if (
    !kind(action) ||
    !(
      v.resultSubscriptionRevision === null ||
      revision(v.resultSubscriptionRevision)
    ) ||
    (v.status === "APPLIED"
      ? !(
          Number(v.resultSubscriptionRevision) >
          Number(v.expectedSubscriptionRevision)
        )
      : v.resultSubscriptionRevision !== null)
  )
    fail();
  const terminal = v.status === "FAILED" || v.status === "SUPERSEDED";
  if (
    terminal
      ? ![
          "review_required",
          action === "upgrade" ? "invoice_void" : "create_compensated",
        ].includes(v.failure)
      : v.failure !== null
  )
    fail();
  let detail;
  if (action === "upgrade") {
    if (
      !["ready", "started"].includes(v.dispatchState) ||
      (v.status === "APPLIED" && v.dispatchState !== "started")
    )
      fail();
    detail = { dispatchState: v.dispatchState };
  } else {
    if (
      v.effect !== null &&
      (!v.effect ||
        !["schedule_create", "schedule_configure", "schedule_release"].includes(
          v.effect.kind,
        ) ||
        !["ready", "started", "observed"].includes(v.effect.state))
    )
      fail();
    if (
      v.status === "APPLIED" &&
      (v.effect?.kind !== "schedule_configure" ||
        v.effect?.state !== "observed")
    )
      fail();
    detail = {
      effect: v.effect === null ? null : pick(v.effect, ["kind", "state"]),
    };
  }
  return {
    ...base,
    kind: action,
    resultSubscriptionRevision: v.resultSubscriptionRevision,
    ...detail,
    failure: v.failure,
  };
}
function invoice(v) {
  const fields = [
    "amountDueCents",
    "subtotalCents",
    "discountCents",
    "taxCents",
    "totalCents",
    "startingBalanceCents",
  ];
  // Signed subtotals/balances are valid for credits and prorations. The server owns financial proof.
  if (
    !v ||
    fields.some((k) => !Number.isSafeInteger(v[k])) ||
    v.amountDueCents < 0 ||
    v.discountCents < 0 ||
    v.taxCents < 0
  )
    fail();
  return pick(v, fields);
}
export function projectPlanChangeQuote(
  value,
  action,
  policy,
  now = Date.now(),
) {
  const v = value?.review;
  const fields = [
    "kind",
    "subscriptionId",
    "expectedSubscriptionRevision",
    "sourcePlanKey",
    "targetPlanKey",
    "catalogVersion",
    "currency",
    "currentPeriodStart",
    "currentPeriodEnd",
    "targetBaseAmountCents",
    "targetAllowanceUsd",
    "observedAt",
    "expiresAt",
  ];
  if (
    !id(value?.quoteId) ||
    !v ||
    !kind(action) ||
    v.kind !== `${action}_estimate` ||
    !id(v.subscriptionId) ||
    !revision(v.expectedSubscriptionRevision) ||
    !policy.planKeys.includes(v.sourcePlanKey) ||
    !policy.planKeys.includes(v.targetPlanKey) ||
    v.sourcePlanKey === v.targetPlanKey ||
    v.currency !== policy.planCurrency ||
    policy.planInterval !== "month" ||
    typeof v.catalogVersion !== "string" ||
    !v.catalogVersion ||
    !Number.isSafeInteger(v.targetBaseAmountCents) ||
    v.targetBaseAmountCents <= 0 ||
    !amount(v.targetAllowanceUsd) ||
    ["currentPeriodStart", "currentPeriodEnd", "observedAt", "expiresAt"].some(
      (k) => !date(v[k]),
    )
  )
    fail();
  const start = Date.parse(v.currentPeriodStart),
    end = Date.parse(v.currentPeriodEnd),
    observed = Date.parse(v.observedAt),
    expires = Date.parse(v.expiresAt);
  if (
    start >= end ||
    observed < start ||
    observed >= end ||
    observed > now + 5000 ||
    expires <= now ||
    expires <= observed ||
    expires > end ||
    expires - observed > 60000
  )
    fail();
  let detail;
  if (action === "upgrade") {
    const effective = v.prorationDate * 1000;
    if (
      !Number.isSafeInteger(v.prorationDate) ||
      v.prorationDate <= 0 ||
      effective < start ||
      effective > observed ||
      observed - effective >= 1000 ||
      !amount(v.additionalAllowanceUsd)
    )
      fail();
    detail = {
      prorationDate: v.prorationDate,
      additionalAllowanceUsd: v.additionalAllowanceUsd,
      dueNow: invoice(v.dueNow),
    };
  } else {
    if (
      !date(v.effectiveAt) ||
      Date.parse(v.effectiveAt) !== end ||
      v.amountDueNowCents !== 0
    )
      fail();
    detail = { effectiveAt: v.effectiveAt, amountDueNowCents: 0 };
  }
  return {
    quoteId: value.quoteId,
    review: {
      ...pick(v, fields),
      ...detail,
      recurringEstimate: invoice(v.recurringEstimate),
    },
  };
}
export function projectPendingPlanChanges(page, policy) {
  if (
    !page ||
    !date(page.observedAt) ||
    !Array.isArray(page.items) ||
    page.items.length > 20 ||
    !(page.nextCursor === null || cursor(page.nextCursor))
  )
    fail();
  const ids = new Set();
  const items = page.items.map((v) => {
    const base = commandBase(v, policy);
    if (
      !kind(v.kind) ||
      !["PREPARED", "OUTCOME_UNKNOWN"].includes(v.status) ||
      !date(v.createdAt) ||
      !["not_started", "unleased", "active", "expired"].includes(v.lease) ||
      !v.source ||
      !["current", "changed", "unavailable"].includes(v.source.state) ||
      !(
        v.source.currentSubscriptionRevision === null ||
        revision(v.source.currentSubscriptionRevision)
      ) ||
      ids.has(v.commandId)
    )
      fail();
    if (
      (v.status === "PREPARED") !== (v.lease === "not_started") ||
      (v.source.state === "unavailable" &&
        v.source.currentSubscriptionRevision !== null) ||
      (v.source.state === "current" &&
        v.source.currentSubscriptionRevision !== v.expectedSubscriptionRevision)
    )
      fail();
    ids.add(v.commandId);
    return {
      ...base,
      kind: v.kind,
      createdAt: v.createdAt,
      lease: v.lease,
      source: pick(v.source, ["state", "currentSubscriptionRevision"]),
    };
  });
  return { observedAt: page.observedAt, items, nextCursor: page.nextCursor };
}
export function projectUpgradePayment(v, policy, now = Date.now()) {
  const command = projectPlanChangeCommand(v?.command, "upgrade", policy);
  if (v.continuation === null) return { command, continuation: null };
  const c = v.continuation;
  if (
    !c ||
    command.status !== "OUTCOME_UNKNOWN" ||
    c.kind !== "hosted_invoice" ||
    !Number.isSafeInteger(c.amountDueCents) ||
    c.amountDueCents <= 0 ||
    c.currency !== policy.planCurrency ||
    !["requires_action", "requires_payment_method"].includes(c.paymentState) ||
    !date(c.expiresAt) ||
    Date.parse(c.expiresAt) <= now ||
    typeof c.hostedInvoiceUrl !== "string" ||
    c.hostedInvoiceUrl.trim() !== c.hostedInvoiceUrl
  )
    fail();
  let url;
  try {
    url = new URL(c.hostedInvoiceUrl);
  } catch {
    fail();
  }
  if (
    url.href !== c.hostedInvoiceUrl ||
    url.origin !== "https://invoice.stripe.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith("/i/") ||
    url.pathname.length <= 3
  )
    fail();
  return {
    command,
    continuation: pick(c, [
      "kind",
      "hostedInvoiceUrl",
      "amountDueCents",
      "currency",
      "paymentState",
      "expiresAt",
    ]),
  };
}
export function validatePlanChangeInput(operation, input, policy) {
  const fields = {
    review: ["kind", "subscriptionId", "revision", "targetPlanKey"],
    confirm: ["kind", "quoteId"],
    status: ["kind", "commandId"],
    pending: ["cursor"],
    payment: ["commandId"],
  }[operation];
  if (
    !fields ||
    !input ||
    Object.keys(input).some((k) => !fields.includes(k)) ||
    (["review", "confirm", "status"].includes(operation) && !kind(input.kind))
  )
    fail(400);
  if (
    operation === "review" &&
    (!id(input.subscriptionId) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision <= 0 ||
      !policy.planKeys.includes(input.targetPlanKey))
  )
    fail(400);
  if (operation === "confirm" && !id(input.quoteId)) fail(400);
  if (["status", "payment"].includes(operation) && !id(input.commandId))
    fail(400);
  if (
    operation === "pending" &&
    input.cursor !== undefined &&
    !cursor(input.cursor)
  )
    fail(400);
}
/** Transport is the existing private, epoch-fenced billing session. No credential or receipt storage. */
export async function executePlanChange(
  operation,
  input,
  { policy, request: transport },
) {
  validatePlanChangeInput(operation, input, policy);
  const request = async (path, options) => {
    const envelope = await transport(path, options);
    if (envelope?.success !== true) fail();
    return envelope;
  };
  const base = "/api/v1/subscriptions";
  if (operation === "pending")
    return projectPendingPlanChanges(
      (
        await request(
          `${base}/plan-change/commands?limit=20${input.cursor ? "&cursor=" + encodeURIComponent(input.cursor) : ""}`,
        )
      )?.data,
      policy,
    );
  if (operation === "payment") {
    const result = projectUpgradePayment(
      (
        await request(`${base}/upgrade/${input.commandId}/payment`, {
          method: "POST",
        })
      )?.data,
      policy,
    );
    if (result.command.commandId !== input.commandId) fail();
    return result;
  }
  if (operation === "review") {
    const result = projectPlanChangeQuote(
      (
        await request(`${base}/${input.kind}/review`, {
          method: "POST",
          json: {
            subscriptionId: input.subscriptionId,
            expectedSubscriptionRevision: input.revision,
            targetPlanKey: input.targetPlanKey,
          },
        })
      )?.data,
      input.kind,
      policy,
    );
    if (
      result.review.subscriptionId !== input.subscriptionId ||
      result.review.expectedSubscriptionRevision !== String(input.revision) ||
      result.review.targetPlanKey !== input.targetPlanKey
    )
      fail();
    return result;
  }
  const result = projectPlanChangeCommand(
    (
      await request(
        operation === "confirm"
          ? `${base}/${input.kind}/confirm`
          : `${base}/${input.kind}/${input.commandId}`,
        operation === "confirm"
          ? {
              method: "POST",
              json: {
                quoteId: input.quoteId,
                idempotencyKey:
                  "native-plan-change-v1-" +
                  createHash("sha256")
                    .update(`${input.kind}:${input.quoteId}`)
                    .digest("hex"),
              },
            }
          : {},
      )
    )?.data,
    input.kind,
    policy,
  );
  if (operation === "status" && result.commandId !== input.commandId) fail();
  return result;
}
