/** Durable replay claims shared by gateway delivery handlers. */
export interface DeliveryReceiptStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(
    key: string,
    value: string,
    options: { ex: number; nx?: boolean },
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
  delIfEquals(key: string, value: string): Promise<boolean>;
  replaceIfEquals(
    key: string,
    expected: string,
    value: string,
    seconds: number,
  ): Promise<boolean>;
}
export class DeliveryReceiptStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryReceiptStateError";
  }
}
export function cloudflareDeliveryReceiptStore(
  env: Record<string, string | undefined>,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): DeliveryReceiptStore {
  let url: URL;
  try {
    url = new URL(env.GATEWAY_RECEIPTS_URL ?? "");
  } catch {
    throw new DeliveryReceiptStateError("GATEWAY_RECEIPTS_URL is required");
  }
  const token = env.GATEWAY_RECEIPTS_TOKEN;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/internal/delivery-receipts" ||
    !token?.trim()
  )
    throw new DeliveryReceiptStateError("Invalid delivery receipt authority");
  async function call(
    operation: string,
    key: string,
    values: object = {},
  ): Promise<unknown> {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation, key, ...values }),
    });
    if (!response.ok)
      throw new DeliveryReceiptStateError(
        `Delivery receipt state failed (${response.status})`,
      );
    return response.json();
  }
  async function changed(
    operation: string,
    key: string,
    values: object,
  ): Promise<boolean> {
    const result = await call(operation, key, values);
    if (typeof result !== "boolean")
      throw new DeliveryReceiptStateError(
        "Invalid receipt mutation acknowledgement",
      );
    return result;
  }
  return {
    async get<T>(key: string): Promise<T | null> {
      const value = await call("get", key);
      if (value === null) return null;
      if (typeof value !== "string")
        throw new DeliveryReceiptStateError("Invalid stored receipt");
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as T;
      }
    },
    async set(key, value, options) {
      const result = await call("set", key, {
        value,
        seconds: options.ex,
        nx: options.nx === true,
      });
      if (result !== null && result !== "OK")
        throw new DeliveryReceiptStateError(
          "Invalid receipt write acknowledgement",
        );
      return result;
    },
    del: (key) => changed("delete", key, {}),
    delIfEquals: (key, expected) => changed("delete", key, { expected }),
    replaceIfEquals: (key, expected, value, seconds) =>
      changed("replace", key, { expected, value, seconds }),
  };
}
