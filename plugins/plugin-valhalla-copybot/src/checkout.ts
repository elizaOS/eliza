export const CHECKOUT_URL =
  "https://valhalla.lemonsqueezy.com/checkout/buy/4f959b69-81ca-45ca-8c3d-c80347b6b439";
export const LEMON_STORE_ID = 514438;
export const LEMON_PRODUCT_ID = 1498767;
export const LEMON_VARIANT_ID = 2334204;

/** Public checkout link. Email is added only when the person is already signed in. */
export function checkoutLink(base: string, source: string, email = ""): string {
  const trimmed = base.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "";
  }
  const clean = email.trim();
  if (clean.includes("@") && !/\s/.test(clean)) url.searchParams.set("checkout[email]", clean);
  url.searchParams.set("checkout[custom][source]", (source || "portal").trim());
  return url.toString();
}

export function acceptedProduct(body: unknown, productId = LEMON_PRODUCT_ID): boolean {
  if (!body || typeof body !== "object") return false;
  const meta = (body as { meta?: { product_id?: unknown } }).meta;
  return Number(meta?.product_id) === productId;
}
