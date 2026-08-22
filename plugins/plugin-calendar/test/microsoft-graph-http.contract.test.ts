/**
 * Microsoft calendar provider wire behavior against a real loopback HTTP
 * server, including pagination, immutable event ids, retries, privacy, request
 * chunking, account limitations, and secret-reference token resolution.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ConnectorAccount,
  ConnectorAccountManager,
  type IAgentRuntime,
  InMemoryConnectorAccountStorage,
} from "@elizaos/core";
import type { LifeOpsConnectorGrant } from "@elizaos/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  DefaultMicrosoftCalendarTokenResolver,
  DefaultMicrosoftGraphCalendarPort,
  listMicrosoftCalendarAccounts,
  type MicrosoftCalendarAccount,
} from "../src/microsoft/index.js";

const AGENT_ID = "microsoft-graph-contract-agent";
const TIME_MIN = "2026-08-01T00:00:00.000Z";
const TIME_MAX = "2026-08-02T00:00:00.000Z";

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface ContractResponse {
  status?: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

type ContractHandler = (
  request: RecordedRequest,
) => ContractResponse | Promise<ContractResponse>;

function connectorAccount(
  metadata: Record<string, unknown> = {},
): ConnectorAccount {
  return {
    id: "microsoft-owner-account",
    provider: "microsoft",
    role: "OWNER",
    purpose: ["reading"],
    accessGate: "owner_binding",
    status: "connected",
    externalId: "microsoft-user-id",
    displayHandle: "owner@example.test",
    createdAt: Date.parse("2026-07-01T00:00:00.000Z"),
    updatedAt: Date.parse("2026-07-26T00:00:00.000Z"),
    metadata,
  };
}

function microsoftAccount(
  accountKind: MicrosoftCalendarAccount["accountKind"] = "organization",
  write = false,
): MicrosoftCalendarAccount {
  const timestamp = "2026-07-26T00:00:00.000Z";
  const account = connectorAccount({
    accountKind,
    grantedScopes: [write ? "Calendars.ReadWrite" : "Calendars.Read"],
  });
  const grant: LifeOpsConnectorGrant = {
    id: `connector-account:microsoft:${account.id}`,
    agentId: AGENT_ID,
    provider: "microsoft",
    connectorAccountId: account.id,
    side: "owner",
    identity: { sub: "microsoft-user-id", email: "owner@example.test" },
    identityEmail: "owner@example.test",
    grantedScopes: [write ? "Calendars.ReadWrite" : "Calendars.Read"],
    capabilities: [
      "microsoft.calendar.read_basic",
      "microsoft.calendar.read",
      "microsoft.calendar.freebusy",
      ...(write ? (["microsoft.calendar.write"] as const) : []),
    ],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: true,
    cloudConnectionId: null,
    metadata: { accountKind },
    lastRefreshAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { account, grant, accountKind };
}

function graphEvent(id: string): Record<string, unknown> {
  return {
    id,
    subject: "School pickup",
    bodyPreview: "Bring the blue backpack",
    location: { displayName: "School" },
    showAs: "busy",
    start: { dateTime: "2026-08-01T16:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-08-01T17:00:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    webLink: "https://outlook.office.test/calendar/item",
    onlineMeeting: { joinUrl: "https://teams.test/join" },
    organizer: {
      emailAddress: { address: "owner@example.test", name: "Owner" },
    },
    attendees: [
      {
        emailAddress: { address: "coparent@example.test", name: "Co-parent" },
        status: { response: "accepted" },
        type: "required",
      },
    ],
    type: "exception",
    seriesMasterId: "series-immutable-id",
    iCalUId: "ical-stable-id",
    originalStart: "2026-08-01T15:00:00Z",
    changeKey: `change-${id}`,
    lastModifiedDateTime: "2026-07-26T10:00:00Z",
    sensitivity: "private",
    recurrence: {
      pattern: { type: "weekly", interval: 1 },
      range: { type: "noEnd", startDate: "2026-08-01" },
    },
  };
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

let server: Server;
let baseUrl: string;
let handler: ContractHandler;
let requests: RecordedRequest[] = [];

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const recorded: RecordedRequest = {
      method: request.method ?? "GET",
      path: request.url ?? "/",
      headers: request.headers,
      body: await requestBody(request),
    };
    requests.push(recorded);
    const contractResponse = await handler(recorded);
    response.writeHead(contractResponse.status ?? 200, {
      "content-type": "application/json",
      ...contractResponse.headers,
    });
    response.end(JSON.stringify(contractResponse.body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/v1.0/`;
});

beforeEach(() => {
  requests = [];
  handler = () => ({ body: { value: [] } });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function port(
  args: {
    sleep?: (milliseconds: number) => Promise<void>;
    maxRetries?: number;
  } = {},
): DefaultMicrosoftGraphCalendarPort {
  const runtime = {
    agentId: AGENT_ID,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  return new DefaultMicrosoftGraphCalendarPort(runtime, {
    baseUrl,
    allowTestBaseUrl: true,
    tokenResolver: {
      resolve: async () => ({
        value: "wire-contract-token",
        expiresAt: null,
      }),
    },
    sleep: args.sleep,
    maxRetries: args.maxRetries,
  });
}

describe("Microsoft Graph calendar HTTP contract", () => {
  it("retries throttling and follows list and delta pagination with immutable ids", async () => {
    let calendarFirstAttempt = true;
    const sleeps: number[] = [];
    handler = (request) => {
      if (request.path === "/v1.0/me/calendars?$top=1000") {
        if (calendarFirstAttempt) {
          calendarFirstAttempt = false;
          return {
            status: 429,
            headers: { "retry-after": "0" },
            body: { error: { code: "TooManyRequests" } },
          };
        }
        return {
          body: {
            value: [
              {
                id: "primary-calendar",
                name: "Family",
                owner: {
                  emailAddress: { address: "owner@example.test" },
                },
                isDefaultCalendar: true,
                canEdit: true,
              },
            ],
            "@odata.nextLink": `${baseUrl}me/calendars?$skiptoken=second`,
          },
        };
      }
      if (request.path === "/v1.0/me/calendars?$skiptoken=second") {
        return {
          body: {
            value: [
              {
                id: "school-calendar",
                name: "School",
                owner: { address: "owner@example.test" },
              },
            ],
          },
        };
      }
      if (
        request.path ===
        "/v1.0/me/calendars/primary-calendar/calendarView/delta?$skiptoken=second"
      ) {
        return {
          body: {
            value: [
              { id: "deleted-immutable-id", "@removed": { reason: "deleted" } },
              { id: "cancelled-immutable-id", isCancelled: true },
            ],
            "@odata.deltaLink": `${baseUrl}me/calendars/primary-calendar/calendarView/delta?$deltatoken=durable`,
          },
        };
      }
      if (
        request.path.startsWith(
          "/v1.0/me/calendars/primary-calendar/calendarView/delta?",
        )
      ) {
        return {
          body: {
            value: [graphEvent("occurrence-immutable-id")],
            "@odata.nextLink": `${baseUrl}me/calendars/primary-calendar/calendarView/delta?$skiptoken=second`,
          },
        };
      }
      throw new Error(`Unexpected request: ${request.path}`);
    };

    const client = port({
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      maxRetries: 1,
    });
    const account = microsoftAccount();
    const calendars = await client.listCalendars(account);
    const delta = await client.syncCalendarView({
      account,
      calendarId: "primary-calendar",
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
    });

    expect(sleeps).toEqual([0]);
    expect(calendars.map((calendar) => calendar.id)).toEqual([
      "primary-calendar",
      "school-calendar",
    ]);
    expect(calendars[0]).toMatchObject({
      isDefault: true,
      canEdit: true,
      ownerAddress: "owner@example.test",
    });
    expect(delta.incremental).toBe(false);
    expect(delta.deltaLink).toContain("$deltatoken=durable");
    expect(delta.changes).toEqual([
      expect.objectContaining({
        kind: "upsert",
        event: expect.objectContaining({
          id: "occurrence-immutable-id",
          seriesMasterId: "series-immutable-id",
          originalStart: "2026-08-01T15:00:00.000Z",
          changeKey: "change-occurrence-immutable-id",
          recurrence: expect.any(Object),
        }),
      }),
      {
        kind: "tombstone",
        eventId: "deleted-immutable-id",
        reason: "deleted",
      },
      {
        kind: "tombstone",
        eventId: "cancelled-immutable-id",
        reason: "cancelled",
      },
    ]);
    for (const request of requests) {
      expect(request.headers.authorization).toBe("Bearer wire-contract-token");
    }
    const deltaRequest = requests.find((request) =>
      request.path.includes("/calendarView/delta?"),
    );
    expect(deltaRequest?.headers.prefer).toContain('IdType="ImmutableId"');
    expect(deltaRequest?.headers.prefer).toContain('outlook.timezone="UTC"');
  });

  it("follows calendar continuation links beyond the former fixed page ceiling", async () => {
    let page = 0;
    handler = () => {
      page += 1;
      return {
        body: {
          value:
            page === 1_001
              ? [
                  {
                    id: "late-calendar",
                    name: "Late calendar",
                    owner: { address: "owner@example.test" },
                  },
                ]
              : [],
          ...(page === 1_001
            ? {}
            : {
                "@odata.nextLink": `${baseUrl}me/calendars?$skiptoken=page-${page + 1}`,
              }),
        },
      };
    };

    const calendars = await port().listCalendars(microsoftAccount());

    expect(page).toBe(1_001);
    expect(calendars).toEqual([
      expect.objectContaining({ id: "late-calendar", name: "Late calendar" }),
    ]);
  });

  it("creates one-off events with a stable transaction id and explicit invitation approval", async () => {
    handler = (request) => {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/v1.0/me/calendars/family%2Fcalendar/events");
      expect(request.headers.prefer).toContain('IdType="ImmutableId"');
      expect(request.headers.prefer).toContain('outlook.timezone="UTC"');
      const payload = JSON.parse(request.body) as {
        subject: string;
        body: { contentType: string; content: string };
        start: { dateTime: string; timeZone: string };
        end: { dateTime: string; timeZone: string };
        location: { displayName: string };
        attendees: Array<{
          emailAddress: { address: string; name: string };
          type: string;
        }>;
        transactionId: string;
      };
      expect(payload).toMatchObject({
        subject: "School conference",
        body: { contentType: "text", content: "Bring the progress report" },
        start: {
          dateTime: "2026-08-01T19:00:00.000",
          timeZone: "UTC",
        },
        end: {
          dateTime: "2026-08-01T20:00:00.000",
          timeZone: "UTC",
        },
        location: { displayName: "Room 12" },
        attendees: [
          {
            emailAddress: {
              address: "coparent@example.test",
              name: "Co-parent",
            },
            type: "required",
          },
        ],
      });
      expect(payload.transactionId).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/u,
      );
      return {
        status: 201,
        body: graphEvent("created-immutable-id"),
      };
    };

    const client = port();
    const request = {
      account: microsoftAccount("organization", true),
      calendarId: "family/calendar",
      title: "School conference",
      description: "Bring the progress report",
      location: "Room 12",
      startAt: "2026-08-01T19:00:00.000Z",
      endAt: "2026-08-01T20:00:00.000Z",
      attendees: [
        {
          email: "coparent@example.test",
          displayName: "Co-parent",
          optional: false,
        },
      ],
      notifyAttendees: true,
      idempotencyKey: "approval:school-conference:create",
    } as const;
    const first = await client.createEvent(request);
    await client.createEvent(request);

    expect(first).toMatchObject({
      id: "created-immutable-id",
      subject: "School pickup",
      changeKey: "change-created-immutable-id",
    });
    const transactionIds = requests.map(
      (entry) =>
        (
          JSON.parse(entry.body) as {
            transactionId: string;
          }
        ).transactionId,
    );
    expect(transactionIds[0]).toBe(transactionIds[1]);
    expect(requests[0]?.headers.authorization).toBe(
      "Bearer wire-contract-token",
    );
  });

  it("fails before the wire without write scope or attendee-send approval", async () => {
    const base = {
      calendarId: "primary-calendar",
      title: "School conference",
      startAt: "2026-08-01T19:00:00.000Z",
      endAt: "2026-08-01T20:00:00.000Z",
      attendees: [],
      notifyAttendees: false,
      idempotencyKey: "approval:school-conference:create",
    } as const;

    await expect(
      port().createEvent({
        ...base,
        account: microsoftAccount(),
      }),
    ).rejects.toMatchObject({
      code: "MICROSOFT_CALENDAR_PERMISSION_MISSING",
    });
    await expect(
      port().createEvent({
        ...base,
        account: microsoftAccount("organization", true),
        attendees: [{ email: "coparent@example.test" }],
      }),
    ).rejects.toMatchObject({
      code: "MICROSOFT_CALENDAR_ATTENDEE_NOTIFICATION_REQUIRED",
    });
    expect(requests).toEqual([]);
  });

  it("chunks getSchedule at twenty and returns only anonymous intervals and errors", async () => {
    handler = (request) => {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/v1.0/me/calendar/getSchedule");
      expect(request.headers.prefer).toBe('outlook.timezone="UTC"');
      const payload = JSON.parse(request.body) as {
        schedules: string[];
        startTime: { dateTime: string; timeZone: string };
        endTime: { dateTime: string; timeZone: string };
        availabilityViewInterval: number;
      };
      expect(payload.startTime).toEqual({
        dateTime: "2026-08-01T00:00:00.000",
        timeZone: "UTC",
      });
      expect(payload.endTime).toEqual({
        dateTime: "2026-08-02T00:00:00.000",
        timeZone: "UTC",
      });
      expect(payload.availabilityViewInterval).toBe(15);
      return {
        body: {
          value: payload.schedules.map((scheduleId, index) =>
            scheduleId === "guest-21@example.test"
              ? {
                  scheduleId,
                  error: { responseCode: "ErrorMailRecipientNotFound" },
                }
              : {
                  scheduleId,
                  scheduleItems: [
                    {
                      status: index === 0 ? "tentative" : "free",
                      subject: "Private medical appointment",
                      location: "Private location",
                      start: {
                        dateTime: "2026-08-01T10:00:00.0000000",
                        timeZone: "UTC",
                      },
                      end: {
                        dateTime: "2026-08-01T10:30:00.0000000",
                        timeZone: "UTC",
                      },
                    },
                  ],
                },
          ),
        },
      };
    };
    const schedules = Array.from(
      { length: 21 },
      (_, index) => `guest-${index + 1}@example.test`,
    );
    const result = await port().getSchedule({
      account: microsoftAccount(),
      schedules,
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
      timeZone: "America/Los_Angeles",
    });

    expect(requests).toHaveLength(2);
    expect(
      (JSON.parse(requests[0]?.body ?? "{}") as { schedules: string[] })
        .schedules,
    ).toHaveLength(20);
    expect(
      (JSON.parse(requests[1]?.body ?? "{}") as { schedules: string[] })
        .schedules,
    ).toHaveLength(1);
    expect(result[0]).toEqual({
      scheduleId: "guest-1@example.test",
      intervals: [
        {
          startAt: "2026-08-01T10:00:00.000Z",
          endAt: "2026-08-01T10:30:00.000Z",
          status: "tentative",
        },
      ],
      error: null,
    });
    expect(result.at(-1)).toMatchObject({
      scheduleId: "guest-21@example.test",
      intervals: [],
      error: { code: "ErrorMailRecipientNotFound" },
    });
    expect(JSON.stringify(result)).not.toContain("medical");
    expect(JSON.stringify(result)).not.toContain("Private location");
  });

  it("rejects personal-account schedule lookups before sending a request", async () => {
    await expect(
      port().getSchedule({
        account: microsoftAccount("personal"),
        schedules: ["guest@example.test"],
        timeMin: TIME_MIN,
        timeMax: TIME_MAX,
      }),
    ).rejects.toMatchObject({
      code: "MICROSOFT_GET_SCHEDULE_PERSONAL_UNSUPPORTED",
    });
    expect(requests).toEqual([]);
  });

  it("resolves access tokens only through credential references and rejects plaintext", async () => {
    const secretReader = {
      getGlobal: vi.fn(async (key: string) =>
        key === "vault/microsoft/access" ? "resolved-access-value" : null,
      ),
    };
    const runtime = {
      agentId: AGENT_ID,
      adapter: {
        listConnectorAccountCredentialRefs: async () => [
          {
            credentialType: "oauth.access_token",
            vaultRef: "vault/microsoft/access",
            expiresAt: Date.now() + 3_600_000,
          },
        ],
      },
      getService: () => secretReader,
      getSetting: () => undefined,
    } as unknown as IAgentRuntime;
    const resolver = new DefaultMicrosoftCalendarTokenResolver(runtime);

    await expect(resolver.resolve(connectorAccount())).resolves.toEqual({
      value: "resolved-access-value",
      expiresAt: expect.any(Number),
    });
    expect(secretReader.getGlobal).toHaveBeenCalledWith(
      "vault/microsoft/access",
    );
    await expect(
      resolver.resolve(
        connectorAccount({ accessToken: "plaintext-is-not-accepted" }),
      ),
    ).rejects.toMatchObject({
      code: "MICROSOFT_PLAINTEXT_CREDENTIAL_REJECTED",
    });
  });

  it("derives least-privilege capabilities from connected account scopes", async () => {
    const storage = new InMemoryConnectorAccountStorage();
    const connected = connectorAccount({
      accountKind: "organization",
      grantedScopes: ["openid", "Calendars.ReadBasic"],
      credentialRefs: {
        "oauth.access_token": { vaultRef: "vault/microsoft/access" },
      },
    });
    await storage.upsertAccount(connected);
    await storage.upsertAccount({
      ...connectorAccount({ grantedScopes: ["Calendars.ReadWrite"] }),
      id: "disabled-account",
      status: "disabled",
    });
    const manager = new ConnectorAccountManager(undefined, storage);
    const runtime = {
      agentId: AGENT_ID,
      getService: () => manager,
    } as unknown as IAgentRuntime;

    await expect(
      listMicrosoftCalendarAccounts({
        runtime,
        side: "owner",
        grantId: `connector-account:microsoft:${connected.id}`,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account: expect.objectContaining({ id: connected.id }),
        accountKind: "organization",
        grant: expect.objectContaining({
          provider: "microsoft",
          connectorAccountId: connected.id,
          side: "owner",
          grantedScopes: ["openid", "Calendars.ReadBasic"],
          capabilities: [
            "microsoft.basic_identity",
            "microsoft.calendar.read_basic",
            "microsoft.calendar.freebusy",
          ],
          tokenRef: null,
        }),
      }),
    ]);
  });

  it("refreshes expired credentials and persists only rotated secret references", async () => {
    const secrets = new Map([
      ["vault/microsoft/access", "expired-access-value"],
      ["vault/microsoft/refresh", "refresh-input-value"],
    ]);
    const persistedRefs: Array<Record<string, unknown>> = [];
    const adapter = {
      listConnectorAccountCredentialRefs: async () => [
        {
          credentialType: "oauth.access_token",
          vaultRef: "vault/microsoft/access",
          expiresAt: 1,
        },
        {
          credentialType: "oauth.refresh_token",
          vaultRef: "vault/microsoft/refresh",
          expiresAt: null,
        },
      ],
      setConnectorAccountCredentialRef: async (
        ref: Record<string, unknown>,
      ) => {
        persistedRefs.push(ref);
        return ref;
      },
    };
    // Durable vault-shaped writer: rotation must persist through a durable
    // store (`set`), never the in-memory SECRETS `setGlobal` path (#18080).
    const secretService = {
      getGlobal: async (key: string) => secrets.get(key) ?? null,
      set: async (key: string, value: string) => {
        secrets.set(key, value);
      },
    };
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
        );
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("client_id")).toBe("calendar-client-id");
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("refresh-input-value");
        expect(form.get("client_secret")).toBeNull();
        return Response.json({
          access_token: "rotated-access-value",
          refresh_token: "rotated-refresh-value",
          expires_in: 3600,
        });
      },
    );
    const runtime = {
      agentId: AGENT_ID,
      adapter,
      fetch: fetchImpl,
      getService: () => secretService,
      getSetting: (key: string) =>
        key === "MICROSOFT_CLIENT_ID" ? "calendar-client-id" : undefined,
    } as unknown as IAgentRuntime;
    const resolver = new DefaultMicrosoftCalendarTokenResolver(runtime, () =>
      Date.parse("2026-07-26T00:00:00.000Z"),
    );

    await expect(
      resolver.resolve(
        connectorAccount({
          tenantId: "organizations",
          grantedScopes: ["Calendars.Read", "offline_access"],
        }),
      ),
    ).resolves.toMatchObject({
      value: "rotated-access-value",
      expiresAt: expect.any(Number),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(secrets).toEqual(
      new Map([
        ["vault/microsoft/access", "rotated-access-value"],
        ["vault/microsoft/refresh", "rotated-refresh-value"],
      ]),
    );
    expect(persistedRefs).toEqual([
      expect.objectContaining({
        credentialType: "oauth.access_token",
        vaultRef: "vault/microsoft/access",
      }),
      expect.objectContaining({
        credentialType: "oauth.refresh_token",
        vaultRef: "vault/microsoft/refresh",
      }),
    ]);
    expect(JSON.stringify(persistedRefs)).not.toContain("rotated-access-value");
    expect(JSON.stringify(persistedRefs)).not.toContain(
      "rotated-refresh-value",
    );
  });
});
