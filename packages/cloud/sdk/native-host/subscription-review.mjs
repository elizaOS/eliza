import { NativeCloudServiceError } from "./errors.mjs";

/** Public financial terms only. A digest compares terms; it is not authority. */
export function projectRenewalReview(value, policy, now = Date.now()) {
  const invalid = () => {
    throw new NativeCloudServiceError(
      "Subscription renewal review is unavailable",
      { status: 502 },
    );
  };
  const dates = ["renewalAt", "nextPeriodEnd", "observedAt", "expiresAt"];
  const amounts = [
    "baseAmountCents",
    "subtotalCents",
    "discountCents",
    "taxCents",
    "totalCents",
    "startingBalanceCents",
    "amountDueCents",
  ];
  if (
    !value ||
    value.kind !== "renewal_estimate" ||
    typeof value.subscriptionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.subscriptionId,
    ) ||
    typeof value.expectedSubscriptionRevision !== "string" ||
    !/^[1-9][0-9]*$/.test(value.expectedSubscriptionRevision) ||
    !Number.isSafeInteger(Number(value.expectedSubscriptionRevision)) ||
    !policy.planKeys.includes(value.planKey) ||
    value.currency !== policy.planCurrency ||
    value.interval !== policy.planInterval ||
    value.intervalCount !== 1 ||
    typeof value.catalogVersion !== "string" ||
    !value.catalogVersion ||
    typeof value.termsDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.termsDigest) ||
    dates.some(
      (key) =>
        typeof value[key] !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value[key]) ||
        !Number.isFinite(Date.parse(value[key])),
    ) ||
    amounts.some(
      (key) =>
        !Number.isSafeInteger(value[key]) ||
        (key !== "startingBalanceCents" && value[key] < 0),
    ) ||
    value.baseAmountCents <= 0
  )
    return invalid();
  const observed = Date.parse(value.observedAt),
    expires = Date.parse(value.expiresAt);
  if (
    observed > now + 5000 ||
    expires <= now ||
    expires <= observed ||
    expires - observed > 60000 ||
    Date.parse(value.renewalAt) <= now ||
    Date.parse(value.nextPeriodEnd) <= Date.parse(value.renewalAt) ||
    value.discountCents > value.subtotalCents ||
    // taxCents reports inclusive tax (already inside the subtotal) and
    // exclusive tax (added on top) together, so the total adds between none
    // and all of it to the discounted subtotal.
    value.totalCents < value.subtotalCents - value.discountCents ||
    value.totalCents >
      value.subtotalCents - value.discountCents + value.taxCents
  )
    return invalid();
  return Object.fromEntries(
    [
      "kind",
      "subscriptionId",
      "expectedSubscriptionRevision",
      "planKey",
      "catalogVersion",
      "currency",
      "interval",
      "intervalCount",
      ...amounts,
      ...dates,
      "termsDigest",
    ].map((key) => [key, value[key]]),
  );
}
