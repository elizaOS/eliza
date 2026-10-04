/** Server-owned additional native clients. Request data can select, never define, a registration. */
export interface RegisteredMobileClient {
  clientId: string;
  appId: string;
  redirectUri: string;
  enabled: boolean;
}
export type MobileClientSelection =
  | { ok: true; registration: RegisteredMobileClient }
  | { ok: false; code: "invalid_client" | "server_configuration_error" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function selectRegisteredMobileClient(
  raw: unknown,
  clientId: string,
  reserved: { clientId: string; appId: unknown; redirectUri: string },
): MobileClientSelection {
  if (raw === undefined || raw === "") return { ok: false, code: "invalid_client" };
  if (typeof raw !== "string" || raw.length > 16_384)
    return { ok: false, code: "server_configuration_error" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // error-policy:J3 Malformed operator configuration cannot register a client.
    return { ok: false, code: "server_configuration_error" };
  }
  if (!Array.isArray(value) || value.length > 32)
    return { ok: false, code: "server_configuration_error" };
  const clients = new Set([reserved.clientId]);
  const apps = new Set([typeof reserved.appId === "string" ? reserved.appId.toLowerCase() : ""]);
  const redirects = new Set([reserved.redirectUri]);
  let selected: RegisteredMobileClient | undefined;
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (key) => !["clientId", "appId", "redirectUri", "enabled"].includes(key),
      ) ||
      typeof item.clientId !== "string" ||
      !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+$/.test(item.clientId) ||
      item.clientId.length > 200 ||
      typeof item.appId !== "string" ||
      !UUID.test(item.appId) ||
      typeof item.redirectUri !== "string" ||
      item.redirectUri.length > 2_000 ||
      typeof item.enabled !== "boolean"
    )
      return { ok: false, code: "server_configuration_error" };
    let url: URL;
    try {
      url = new URL(item.redirectUri);
    } catch {
      // error-policy:J3 Invalid redirect configuration fails closed.
      return { ok: false, code: "server_configuration_error" };
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href !== item.redirectUri ||
      clients.has(item.clientId) ||
      apps.has(item.appId.toLowerCase()) ||
      redirects.has(item.redirectUri)
    ) {
      return { ok: false, code: "server_configuration_error" };
    }
    clients.add(item.clientId);
    apps.add(item.appId.toLowerCase());
    redirects.add(item.redirectUri);
    if (item.clientId === clientId && item.enabled) selected = item;
  }
  return selected ? { ok: true, registration: selected } : { ok: false, code: "invalid_client" };
}
