import type {
  FacilitatorVerificationResponse,
  FacilitatorVerifyContext,
} from "./types.js";

/**
 * When true, facilitator JSON must echo `resource`, route, `priceInCents`, and
 * `paymentConfig` so a generic 200 cannot unlock unrelated routes.
 * Set `X402_FACILITATOR_RELAXED_BINDING=1` if your facilitator does not return these fields yet.
 */
export function isFacilitatorBindingRelaxed(): boolean {
  return (
    process.env.X402_FACILITATOR_RELAXED_BINDING === "true" ||
    process.env.X402_FACILITATOR_RELAXED_BINDING === "1"
  );
}

function relaxedPayloadMatchesContext(
  data: FacilitatorVerificationResponse,
  ctx: FacilitatorVerifyContext,
): boolean {
  if (typeof data.resource === "string" && data.resource !== ctx.resource) {
    return false;
  }
  if (typeof data.routePath === "string" && data.routePath !== ctx.routePath) {
    return false;
  }
  if (typeof data.route === "string" && data.route !== ctx.routePath) {
    return false;
  }
  if (
    typeof data.priceInCents === "number" &&
    Number.isFinite(data.priceInCents) &&
    data.priceInCents !== ctx.priceInCents
  ) {
    return false;
  }
  if (typeof data.paymentConfig === "string") {
    if (!ctx.paymentConfigNames.includes(data.paymentConfig)) {
      return false;
    }
  }
  if (Array.isArray(data.paymentConfigs)) {
    for (const n of data.paymentConfigs) {
      if (typeof n === "string" && !ctx.paymentConfigNames.includes(n)) {
        return false;
      }
    }
  }
  return true;
}

function strictPaymentConfigOk(
  data: FacilitatorVerificationResponse,
  ctx: FacilitatorVerifyContext,
): boolean {
  if (typeof data.paymentConfig === "string") {
    return ctx.paymentConfigNames.includes(data.paymentConfig);
  }
  if (Array.isArray(data.paymentConfigs) && data.paymentConfigs.length > 0) {
    const names = data.paymentConfigs.filter(
      (x): x is string => typeof x === "string",
    );
    if (names.length === 0) return false;
    return names.every((n) => ctx.paymentConfigNames.includes(n));
  }
  return false;
}

function strictPayloadMatchesContext(
  data: FacilitatorVerificationResponse,
  ctx: FacilitatorVerifyContext,
): boolean {
  if (typeof data.resource !== "string" || data.resource !== ctx.resource) {
    return false;
  }
  const routeOk =
    (typeof data.routePath === "string" && data.routePath === ctx.routePath) ||
    (typeof data.route === "string" && data.route === ctx.routePath);
  if (!routeOk) {
    return false;
  }
  if (
    typeof data.priceInCents !== "number" ||
    !Number.isFinite(data.priceInCents) ||
    data.priceInCents !== ctx.priceInCents
  ) {
    return false;
  }
  if (!strictPaymentConfigOk(data, ctx)) {
    return false;
  }
  return true;
}

export function facilitatorVerifyResponseMatchesRoute(
  data: FacilitatorVerificationResponse,
  ctx: FacilitatorVerifyContext,
  relaxed: boolean,
): boolean {
  return relaxed
    ? relaxedPayloadMatchesContext(data, ctx)
    : strictPayloadMatchesContext(data, ctx);
}
