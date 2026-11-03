/** Store product. Play Billing on Android, Apple IAP on iOS. The sideload paywall opens Lemon Squeezy. */
export const PRO_PRODUCT_ID = "valhalla_pro_monthly";
export const LEMON_PRODUCT_ID = 1498767;
const CHECKOUT_URL =
  "https://valhalla.lemonsqueezy.com/checkout/buy/4f959b69-81ca-45ca-8c3d-c80347b6b439";

export function checkoutLink(source: string, email = ""): string {
  const url = new URL(CHECKOUT_URL);
  const clean = email.trim();
  if (clean.includes("@") && !/\s/.test(clean)) url.searchParams.set("checkout[email]", clean);
  url.searchParams.set("checkout[custom][source]", source);
  return url.toString();
}

export function proPurchaseMessage(): string {
  return `Store builds use ${PRO_PRODUCT_ID} through Google Play Billing or Apple In-App Purchase. Go Pro opens Lemon Squeezy at the $9.99/mo launch price. Pro is not a promise of profit.`;
}

/** Public license endpoint. No API secret is sent. The key must be for product 1498767. */
export async function activateLicense(key: string): Promise<string> {
  try {
    const response = await fetch("https://api.lemonsqueezy.com/v1/licenses/activate", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        license_key: key.trim(),
        instance_name: "valhalla-phone",
      }).toString(),
    });
    if (!response.ok)
      return "The license service could not be reached. A saved Pro license stays on for 7 days offline.";
    const body = (await response.json()) as {
      activated?: boolean;
      license_key?: { status?: string };
      meta?: { product_id?: number };
    };
    const productOk = Number(body.meta?.product_id) === LEMON_PRODUCT_ID;
    if (body.activated === true && body.license_key?.status === "active" && productOk) {
      return "Pro is on. This is not a promise of profit. The app still cannot send or withdraw.";
    }
    return "That license was not accepted.";
  } catch {
    return "The license service could not be reached.";
  }
}
