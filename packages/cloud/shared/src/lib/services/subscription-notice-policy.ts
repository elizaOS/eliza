/** Reads explicit server-approved, per-revision dispatch configuration; absent policy never supplies a recipient, cadence, timezone or message. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

const schema = z
  .object({
    approvalReference: z.string().trim().min(1),
    organizationId: z.string().uuid(),
    subscriptionId: z.string().uuid(),
    sourceRevision: z.number().int().positive().safe(),
    kind: z.literal("cancel_effective"),
    recipient: z.string().email(),
    sendAt: z.string().datetime(),
    notAfter: z.string().datetime(),
    timezone: z.string().min(1),
    subject: z.string().min(1),
    text: z.string().min(1),
    html: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Date(value.sendAt) >= new Date(value.notAfter))
      ctx.addIssue({ code: "custom", message: "Dispatch window must be positive" });
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.timezone });
    } catch {
      // error-policy:J3 Invalid explicit timezone remains unavailable.
      ctx.addIssue({ code: "custom", message: "Timezone is invalid" });
    }
  });
export type ApprovedSubscriptionNoticeDispatch = z.infer<typeof schema>;
export type SubscriptionNoticePolicy =
  | { state: "unavailable"; reason: "not_configured" | "invalid_configuration" | "not_registered" }
  | { state: "configured"; value: ApprovedSubscriptionNoticeDispatch; digest: string };
export function resolveSubscriptionNoticePolicy(source: {
  organization_id: string;
  subscription_id: string;
  source_revision: number;
}): SubscriptionNoticePolicy {
  const raw = getCloudAwareEnv().SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON;
  if (!raw) return { state: "unavailable", reason: "not_configured" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // error-policy:J3 Malformed server configuration cannot authorize submission.
    return { state: "unavailable", reason: "invalid_configuration" };
  }
  const parsed = z.array(schema).safeParse(data);
  if (!parsed.success) return { state: "unavailable", reason: "invalid_configuration" };
  const matches = parsed.data.filter(
    (p) =>
      p.organizationId === source.organization_id &&
      p.subscriptionId === source.subscription_id &&
      p.sourceRevision === source.source_revision,
  );
  if (matches.length !== 1)
    return {
      state: "unavailable",
      reason: matches.length ? "invalid_configuration" : "not_registered",
    };
  const value = matches[0]!;
  return {
    state: "configured",
    value,
    digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  };
}
