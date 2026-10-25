/** Server-owned additional native clients. Request data can select, never define, a registration. */
export interface RegisteredMobileClient {
  clientId: string;
  appId: string;
  redirectUri: string;
  enabled: boolean;
  /**
   * Lifetime of the `eliza_mobile_` credential this client receives. Optional;
   * the service default (30 days) applies when absent. Bounded to 90 days so a
   * registry edit can never mint an effectively permanent key.
   */
  credentialTtlSeconds?: number;
}
export type MobileClientSelection =
  | { ok: true; registration: RegisteredMobileClient }
  | { ok: false; code: "invalid_client" | "server_configuration_error" };
export const MOBILE_CLIENT_MIN_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;
export const MOBILE_CLIENT_MAX_CREDENTIAL_TTL_SECONDS = 90 * 24 * 60 * 60;
const REGISTRATION_KEYS = [
  "clientId",
  "appId",
  "redirectUri",
  "enabled",
  "credentialTtlSeconds",
];
export interface MobileClientReservation {
  clientId: string;
  appId: unknown;
  redirectUri: string;
}

export type MobileClientRegistryParseResult =
  | { ok: true; registrations: RegisteredMobileClient[] }
  | { ok: false; code: "invalid_client" | "server_configuration_error" };

export type MobileClientRegistryUpdatePlan =
  | { ok: true; changed: boolean; registryJson: string }
  | { ok: false; code: "invalid_client" | "server_configuration_error" };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate every entry without dropping, reordering or normalizing source fields. */
export function parseRegisteredMobileClients(
  raw: unknown,
  reserved: MobileClientReservation,
): MobileClientRegistryParseResult {
  if (raw === undefined || raw === "")
    return { ok: false, code: "invalid_client" };
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
  const apps = new Set([
    typeof reserved.appId === "string" ? reserved.appId.toLowerCase() : "",
  ]);
  const redirects = new Set([reserved.redirectUri]);
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !REGISTRATION_KEYS.includes(key)) ||
      typeof item.clientId !== "string" ||
      !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+$/.test(item.clientId) ||
      item.clientId.length > 200 ||
      typeof item.appId !== "string" ||
      !UUID.test(item.appId) ||
      typeof item.redirectUri !== "string" ||
      item.redirectUri.length > 2_000 ||
      typeof item.enabled !== "boolean" ||
      (item.credentialTtlSeconds !== undefined &&
        (typeof item.credentialTtlSeconds !== "number" ||
          !Number.isInteger(item.credentialTtlSeconds) ||
          item.credentialTtlSeconds <
            MOBILE_CLIENT_MIN_CREDENTIAL_TTL_SECONDS ||
          item.credentialTtlSeconds > MOBILE_CLIENT_MAX_CREDENTIAL_TTL_SECONDS))
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
      item.redirectUri.includes("*") ||
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
  }
  return { ok: true, registrations: value as RegisteredMobileClient[] };
}

export function selectRegisteredMobileClient(
  raw: unknown,
  clientId: string,
  reserved: MobileClientReservation,
): MobileClientSelection {
  const parsed = parseRegisteredMobileClients(raw, reserved);
  if (!parsed.ok) return parsed;
  const selected = parsed.registrations.find(
    (entry) => entry.clientId === clientId && entry.enabled,
  );
  return selected
    ? { ok: true, registration: { ...selected } }
    : { ok: false, code: "invalid_client" };
}

/**
 * Plan one registered client's app UUID correction. The complete returned JSON
 * is private operator configuration: never log it. This does not publish or
 * prove that an unreadable Worker binding matches the supplied source.
 */
export function planRegisteredMobileClientAppIdUpdate(
  raw: unknown,
  clientId: string,
  appId: string,
  reserved: MobileClientReservation,
): MobileClientRegistryUpdatePlan {
  const parsed = parseRegisteredMobileClients(raw, reserved);
  if (!parsed.ok) return parsed;
  if (typeof appId !== "string" || !UUID.test(appId))
    return { ok: false, code: "server_configuration_error" };
  const index = parsed.registrations.findIndex(
    (entry) => entry.clientId === clientId && entry.enabled,
  );
  if (index < 0) return { ok: false, code: "invalid_client" };
  const current = parsed.registrations[index];
  if (current.appId.toLowerCase() === appId.toLowerCase())
    return { ok: true, changed: false, registryJson: raw as string };
  const next = parsed.registrations.slice();
  next[index] = { ...current, appId };
  const registryJson = JSON.stringify(next);
  const validated = parseRegisteredMobileClients(registryJson, reserved);
  return validated.ok ? { ok: true, changed: true, registryJson } : validated;
}
