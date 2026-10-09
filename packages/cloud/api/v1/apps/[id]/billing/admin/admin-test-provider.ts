/** Retains the production Stripe SDK and adapters while controlling only their outbound HTTP responses. */
import Stripe from "stripe";
export function createAdminTestProvider() {
  const state: {
    losePriceResponse: boolean;
    badPrice: boolean;
    charges: boolean;
    failAccountRead: boolean;
    afterAccountCreate: (() => Promise<void>) | null;
  } = {
    losePriceResponse: false,
    badPrice: false,
    charges: true,
    failAccountRead: false,
    afterAccountCreate: null,
  };
  const accounts = new Map<string, ReturnType<typeof account>>();
  const prices = new Map<string, ReturnType<typeof price>>();
  const priceOwners = new Map<string, string>();
  let creates = 0;
  const requests: Array<{
    path: string;
    method: string;
    account: string | null;
    version: string | null;
  }> = [];
  function account(id: string, metadata: Record<string, string>) {
    return {
      id,
      object: "account",
      metadata,
      charges_enabled: state.charges,
      payouts_enabled: true,
      details_submitted: true,
      capabilities: { card_payments: "active", transfers: "active" },
      requirements: { disabled_reason: null, currently_due: [] },
    };
  }
  function price(
    id: string,
    product: string,
    metadata: Record<string, string>,
    amount: number,
  ) {
    return {
      id,
      object: "price",
      active: true,
      livemode: false,
      product,
      metadata,
      currency: "usd",
      unit_amount: amount,
      type: "recurring",
      billing_scheme: "per_unit",
      transform_quantity: null,
      recurring: {
        interval: "month",
        interval_count: 1,
        usage_type: "licensed",
        trial_period_days: null,
      },
    };
  }
  function metadata(body: URLSearchParams) {
    return Object.fromEntries(
      [...body]
        .filter(([key]) => key.startsWith("metadata["))
        .map(([key, value]) => [key.substring(9, key.length - 1), value]),
    );
  }
  const controlledFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = new URLSearchParams(String(init?.body ?? ""));
    const headers = new Headers(init?.headers);
    requests.push({
      path: url.pathname,
      method,
      account: headers.get("stripe-account"),
      version: headers.get("stripe-version"),
    });
    let value: object;
    if (url.pathname === "/v1/balance")
      value = {
        object: "balance",
        livemode: false,
        available: [],
        pending: [],
      };
    else if (url.pathname === "/v1/account")
      value = account("acct_platform", {});
    else if (url.pathname === "/v1/accounts" && method === "POST") {
      const created = account(
        `acct_created${accounts.size + 1}`,
        metadata(body),
      );
      accounts.set(created.id, created);
      if (state.afterAccountCreate !== null) await state.afterAccountCreate();
      value = created;
    } else if (url.pathname === "/v1/accounts")
      value = {
        object: "list",
        data: [...accounts.values()],
        has_more: false,
        url: "/v1/accounts",
      };
    else if (url.pathname.startsWith("/v1/accounts/")) {
      if (state.failAccountRead)
        throw new Error("Controlled unavailable account retrieval");
      const id = url.pathname.split("/").at(-1);
      if (!id) throw new Error("Missing account");
      value = {
        ...(accounts.get(id) ?? account(id, {})),
        charges_enabled: state.charges,
      };
    } else if (url.pathname === "/v1/prices" && method === "POST") {
      creates++;
      const created = price(
        `price_created${prices.size + 1}`,
        body.get("product_data[id]") ?? "",
        metadata(body),
        Number(body.get("unit_amount")),
      );
      const owner = headers.get("stripe-account");
      if (owner === null)
        throw new Error("Price creation needs actual merchant scope");
      priceOwners.set(created.id, owner);
      prices.set(created.id, created);
      if (state.losePriceResponse) {
        state.losePriceResponse = false;
        throw new Error("Controlled lost response after provider creation");
      }
      value = created;
    } else if (url.pathname === "/v1/prices")
      value = {
        object: "list",
        data: [...prices.values()].filter(
          (p) => p.product === url.searchParams.get("product"),
        ),
        has_more: false,
        url: "/v1/prices",
      };
    else if (url.pathname.startsWith("/v1/prices/")) {
      const id = url.pathname.split("/").at(-1);
      const found = id ? prices.get(id) : null;
      if (
        !found ||
        (id && priceOwners.get(id) !== headers.get("stripe-account"))
      )
        return new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: "No such price",
            },
          }),
          { status: 404 },
        );
      value = {
        ...found,
        unit_amount: state.badPrice ? found.unit_amount + 1 : found.unit_amount,
      };
    } else if (url.pathname.startsWith("/v1/products/"))
      value = {
        id: url.pathname.split("/").at(-1),
        object: "product",
        active: true,
        livemode: false,
      };
    else if (url.pathname === "/v1/account_links")
      value = {
        url: "https://connect.stripe.com/setup/fixture",
        expires_at: Math.floor(Date.now() / 1000) + 600,
      };
    else throw new Error(`Unexpected provider path ${url.pathname}`);
    return new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  };
  const stripe = new Stripe("sk_test_admin_fixture", {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(
      Object.assign(controlledFetch, { preconnect: fetch.preconnect }),
    ),
  });
  return { stripe, requests, state, priceCreates: () => creates };
}
