import { oauthService } from "@/lib/services/oauth";
import { logger } from "@/lib/utils/logger";

export const HUBSPOT_API_BASE = "https://api.hubapi.com";

export const DEFAULT_CONTACT_PROPERTIES = [
  "firstname",
  "lastname",
  "email",
  "phone",
  "company",
  "jobtitle",
  "lifecyclestage",
] as const;

export const DEFAULT_COMPANY_PROPERTIES = [
  "name",
  "domain",
  "industry",
  "numberofemployees",
  "annualrevenue",
] as const;

export const DEFAULT_DEAL_PROPERTIES = [
  "dealname",
  "amount",
  "dealstage",
  "pipeline",
  "closedate",
  "hubspot_owner_id",
] as const;

export type HubSpotObjectType = "contacts" | "companies" | "deals";

type HubSpotRecord = {
  id: string;
  properties?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

type HubSpotListResponse = {
  results: HubSpotRecord[];
  paging?: unknown;
  count: number;
  total?: number;
};

type HubSpotOwner = {
  id?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  userId?: string | number;
  teams?: unknown;
};

function hubSpotErrorMessage(response: Response, body: object): string {
  const fallback = `HubSpot API error: ${response.status}`;
  const msg = Reflect.get(body, "message");
  return typeof msg === "string" && msg.length > 0 ? msg : fallback;
}

function isHubSpotRecord(item: object): item is HubSpotRecord {
  const id = Reflect.get(item, "id");
  return typeof id === "string";
}

function hubSpotRecordsFromListBody(body: object): HubSpotRecord[] {
  const raw = Reflect.get(body, "results");
  if (!Array.isArray(raw)) return [];
  const out: HubSpotRecord[] = [];
  for (const item of raw) {
    if (item !== null && typeof item === "object" && isHubSpotRecord(item)) {
      out.push(item);
    }
  }
  return out;
}

function optionalNumberField(body: object, key: string): number | undefined {
  const v = Reflect.get(body, key);
  return typeof v === "number" ? v : undefined;
}

function hubSpotPagingField(body: object): HubSpotListResponse["paging"] | undefined {
  const v = Reflect.get(body, "paging");
  if (v === undefined || v === null) return undefined;
  return typeof v === "object" ? v : undefined;
}

function hubSpotOwnersFromListBody(body: object): HubSpotOwner[] {
  const raw = Reflect.get(body, "results");
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is HubSpotOwner => item !== null && typeof item === "object");
}

export async function getHubSpotTokenForOrg(organizationId: string): Promise<string> {
  try {
    const result = await oauthService.getValidTokenByPlatform({
      organizationId,
      platform: "hubspot",
    });
    return result.accessToken;
  } catch (error) {
    logger.warn("[HubSpotMCP] Failed to get token", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("HubSpot account not connected. Connect in Settings > Connections.");
  }
}

export async function hubspotFetchForOrg(
  organizationId: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = await getHubSpotTokenForOrg(organizationId);
  const url = endpoint.startsWith("http") ? endpoint : `${HUBSPOT_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok && response.status !== 204) {
    const parsed = await response.json().catch((): null => null);
    const message =
      parsed !== null && typeof parsed === "object"
        ? hubSpotErrorMessage(response, parsed)
        : `HubSpot API error: ${response.status}`;
    throw new Error(message);
  }

  return response;
}

export function mapHubSpotRecord(
  record: HubSpotRecord,
  includeTimestamps = true,
): Record<string, unknown> {
  const flattened: Record<string, unknown> = {
    id: record.id,
    ...(record.properties ?? {}),
  };

  if (includeTimestamps) {
    flattened.createdAt = record.createdAt;
    flattened.updatedAt = record.updatedAt;
  }

  return flattened;
}

export function mapHubSpotOwner(owner: HubSpotOwner): Record<string, unknown> {
  return {
    id: owner.id,
    email: owner.email,
    firstName: owner.firstName,
    lastName: owner.lastName,
    userId: owner.userId,
    teams: owner.teams,
  };
}

export async function getHubSpotStatus(organizationId: string): Promise<Record<string, unknown>> {
  const connections = await oauthService.listConnections({
    organizationId,
    platform: "hubspot",
  });

  const active = connections.find((connection) => connection.status === "active");
  if (!active) {
    const expired = connections.find((connection) => connection.status === "expired");
    if (expired) {
      return {
        connected: false,
        status: "expired",
        message: "HubSpot connection expired. Please reconnect in Settings > Connections.",
      };
    }
    return {
      connected: false,
      message: "HubSpot not connected. Connect in Settings > Connections.",
    };
  }

  return {
    connected: true,
    email: active.email,
    scopes: active.scopes,
    linkedAt: active.linkedAt,
  };
}

export async function listHubSpotObjects(
  organizationId: string,
  objectType: HubSpotObjectType,
  options: {
    limit?: number;
    after?: string;
    properties: readonly string[];
  },
): Promise<HubSpotListResponse> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 20),
    properties: options.properties.join(","),
  });
  if (options.after) {
    params.set("after", options.after);
  }

  const response = await hubspotFetchForOrg(
    organizationId,
    `/crm/v3/objects/${objectType}?${params}`,
  );
  const raw = await response.json();
  if (typeof raw !== "object" || raw === null) {
    return { results: [], count: 0 };
  }
  const results = hubSpotRecordsFromListBody(raw);
  return {
    results,
    paging: hubSpotPagingField(raw),
    count: results.length,
    total: optionalNumberField(raw, "total"),
  };
}

export async function getHubSpotObject(
  organizationId: string,
  objectType: HubSpotObjectType,
  objectId: string,
  properties: readonly string[],
): Promise<HubSpotRecord> {
  const params = new URLSearchParams({ properties: properties.join(",") });
  const response = await hubspotFetchForOrg(
    organizationId,
    `/crm/v3/objects/${objectType}/${objectId}?${params}`,
  );
  return (await response.json()) as HubSpotRecord;
}

export async function createHubSpotObject(
  organizationId: string,
  objectType: HubSpotObjectType,
  properties: Record<string, string | number>,
): Promise<HubSpotRecord> {
  const response = await hubspotFetchForOrg(organizationId, `/crm/v3/objects/${objectType}`, {
    method: "POST",
    body: JSON.stringify({ properties }),
  });
  return (await response.json()) as HubSpotRecord;
}

export async function updateHubSpotObject(
  organizationId: string,
  objectType: HubSpotObjectType,
  objectId: string,
  properties: Record<string, string | number>,
): Promise<HubSpotRecord> {
  const response = await hubspotFetchForOrg(
    organizationId,
    `/crm/v3/objects/${objectType}/${objectId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    },
  );
  return (await response.json()) as HubSpotRecord;
}

export async function searchHubSpotObjects(
  organizationId: string,
  objectType: HubSpotObjectType,
  options: {
    query: string;
    limit?: number;
    properties: readonly string[];
  },
): Promise<HubSpotListResponse> {
  const response = await hubspotFetchForOrg(
    organizationId,
    `/crm/v3/objects/${objectType}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query: options.query,
        limit: options.limit ?? 20,
        properties: [...options.properties],
      }),
    },
  );
  const raw = await response.json();
  if (typeof raw !== "object" || raw === null) {
    return { results: [], count: 0 };
  }
  const results = hubSpotRecordsFromListBody(raw);
  return {
    results,
    paging: hubSpotPagingField(raw),
    count: results.length,
    total: optionalNumberField(raw, "total"),
  };
}

export async function listHubSpotOwners(
  organizationId: string,
  options: { limit?: number; email?: string } = {},
): Promise<{ results: HubSpotOwner[]; count: number }> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 100),
  });
  if (options.email) {
    params.set("email", options.email);
  }

  const response = await hubspotFetchForOrg(organizationId, `/crm/v3/owners?${params}`);
  const raw = await response.json();
  if (typeof raw !== "object" || raw === null) {
    return { results: [], count: 0 };
  }
  const results = hubSpotOwnersFromListBody(raw);

  return {
    results,
    count: results.length,
  };
}

export async function createHubSpotAssociation(
  organizationId: string,
  fromObjectType: HubSpotObjectType,
  fromObjectId: string,
  toObjectType: HubSpotObjectType,
  toObjectId: string,
): Promise<void> {
  const associationTypeMap: Record<
    HubSpotObjectType,
    Partial<Record<HubSpotObjectType, number>>
  > = {
    contacts: { companies: 1, deals: 3 },
    companies: { contacts: 2, deals: 5 },
    deals: { contacts: 4, companies: 6 },
  };

  const associationType = associationTypeMap[fromObjectType]?.[toObjectType];
  if (!associationType) {
    throw new Error(`Invalid association: ${fromObjectType} -> ${toObjectType}`);
  }

  await hubspotFetchForOrg(
    organizationId,
    `/crm/v3/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}/${toObjectId}/${associationType}`,
    { method: "PUT" },
  );
}
