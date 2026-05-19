import type {
  AgentRuntime,
  Character,
  CharacterX402Settings,
  PaymentEnabledRoute,
  X402Config,
} from "@elizaos/core";

export const X402_EVENT_PAYMENT_VERIFIED = "PAYMENT_VERIFIED";
export const X402_EVENT_PAYMENT_REQUIRED = "PAYMENT_REQUIRED";

function readCharacterX402(
  settings: Character["settings"] | undefined,
): CharacterX402Settings | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  const raw = (settings as Record<string, unknown>).x402;
  if (!raw || typeof raw !== "object") return undefined;
  return raw as CharacterX402Settings;
}

/** Resolves `x402: true` / partial route config using `character.settings.x402`. */
export function resolveEffectiveX402(
  route: PaymentEnabledRoute,
  runtime: AgentRuntime,
): X402Config | null {
  const cx = readCharacterX402(runtime.character?.settings);
  const raw = route.x402;
  if (raw === true) {
    if (cx?.defaultPriceInCents == null || !cx.defaultPaymentConfigs?.length)
      return null;
    return {
      priceInCents: cx.defaultPriceInCents,
      paymentConfigs: [...cx.defaultPaymentConfigs],
    };
  }
  if (raw && typeof raw === "object") {
    const price = raw.priceInCents ?? cx?.defaultPriceInCents;
    const configs = raw.paymentConfigs ?? cx?.defaultPaymentConfigs;
    if (price == null || !configs?.length) return null;
    return { priceInCents: price, paymentConfigs: [...configs] };
  }
  return null;
}
