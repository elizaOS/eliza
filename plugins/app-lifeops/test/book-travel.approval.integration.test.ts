import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOAuthDir } from "@elizaos/agent";
import type { ActionResult, AgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { saveEnv } from "../../../test/helpers/test-utils";
import {
  approveRequestAction,
  rejectRequestAction,
} from "../src/actions/approval.js";
import { runBookTravelHandler } from "../src/actions/book-travel.js";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import { createFeatureFlagService } from "../src/lifeops/feature-flags.js";
import {
  createLifeOpsConnectorGrant,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

const TEST_TIME_ZONE = "America/Los_Angeles";

let runtime: AgentRuntime;
let testRuntime: RealTestRuntimeResult;
let stateDir: string;
let envBackup: { restore: () => void };
let originalFetch: typeof globalThis.fetch | null = null;

function ownerMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: runtime.agentId as UUID,
    roomId: crypto.randomUUID() as UUID,
    agentId: runtime.agentId as UUID,
    content: { text, source: "dashboard" },
  } as Memory;
}

async function seedGoogleWriteGrant(): Promise<void> {
  const repository = new LifeOpsRepository(runtime);
  const agentId = String(runtime.agentId);
  const tokenRef = `${agentId}/owner/local.json`;
  const tokenPath = path.join(
    resolveOAuthDir(process.env, stateDir),
    "lifeops",
    "google",
    tokenRef,
  );
  const nowIso = new Date().toISOString();

  await fs.promises.mkdir(path.dirname(tokenPath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.promises.writeFile(
    tokenPath,
    JSON.stringify(
      {
        provider: "google",
        agentId,
        side: "owner",
        mode: "local",
        clientId: "book-travel-test-client",
        redirectUri: "http://127.0.0.1/callback",
        accessToken: "book-travel-access-token",
        refreshToken: "book-travel-refresh-token",
        tokenType: "Bearer",
        grantedScopes: [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/calendar",
        ],
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshTokenExpiresAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      null,
      2,
    ),
    { encoding: "utf-8", mode: 0o600 },
  );

  await repository.upsertConnectorGrant(
    createLifeOpsConnectorGrant({
      agentId,
      provider: "google",
      side: "owner",
      identity: {
        email: "shaw@example.com",
        name: "Shaw",
      },
      grantedScopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/calendar",
      ],
      capabilities: [
        "google.basic_identity",
        "google.calendar.read",
        "google.calendar.write",
      ],
      tokenRef,
      mode: "local",
      metadata: {},
      lastRefreshAt: nowIso,
    }),
  );
}

function installTravelAndCalendarFetchStub() {
  let orderReadCount = 0;
  const fetchMock = vi
    .fn()
    .mockImplementation(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );

        if (url.includes("/air/offer_requests")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                id: "ofr_test_123",
                offers: [
                  {
                    id: "off_test_123",
                    total_amount: "299.50",
                    total_currency: "USD",
                    expires_at: "2026-06-01T18:00:00Z",
                    passengers: [
                      {
                        id: "pas_offer_1",
                        type: "adult",
                        given_name: "Tony",
                        family_name: "Stark",
                      },
                    ],
                    payment_requirements: {
                      requires_instant_payment: false,
                      price_guarantee_expires_at: "2026-06-01T18:00:00Z",
                      payment_required_by: "2026-06-02T18:00:00Z",
                    },
                    slices: [
                      {
                        origin: { iata_code: "JFK" },
                        destination: { iata_code: "LHR" },
                        duration: "PT7H30M",
                        fare_brand_name: "Economy",
                        segments: [
                          {
                            origin: { iata_code: "JFK" },
                            destination: { iata_code: "LHR" },
                            departing_at: "2026-06-15T09:00:00Z",
                            arriving_at: "2026-06-15T16:30:00Z",
                            operating_carrier: { iata_code: "BA" },
                            flight_number: "BA178",
                            duration: "PT7H30M",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            }),
          } as Response;
        }

        if (url.includes("/air/offers/off_test_123")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                id: "off_test_123",
                total_amount: "299.50",
                total_currency: "USD",
                expires_at: "2026-06-01T18:00:00Z",
                passengers: [
                  {
                    id: "pas_offer_1",
                    type: "adult",
                    given_name: "Tony",
                    family_name: "Stark",
                  },
                ],
                payment_requirements: {
                  requires_instant_payment: false,
                  price_guarantee_expires_at: "2026-06-01T18:00:00Z",
                  payment_required_by: "2026-06-02T18:00:00Z",
                },
                slices: [
                  {
                    origin: { iata_code: "JFK" },
                    destination: { iata_code: "LHR" },
                    duration: "PT7H30M",
                    fare_brand_name: "Economy",
                    segments: [
                      {
                        origin: { iata_code: "JFK" },
                        destination: { iata_code: "LHR" },
                        departing_at: "2026-06-15T09:00:00Z",
                        arriving_at: "2026-06-15T16:30:00Z",
                        operating_carrier: { iata_code: "BA" },
                        flight_number: "BA178",
                        duration: "PT7H30M",
                      },
                    ],
                  },
                ],
              },
            }),
          } as Response;
        }

        if (url.endsWith("/air/orders")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            data?: { type?: string };
          };
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                id: "ord_test_123",
                booking_reference: "RZPNX8",
                total_amount: "299.50",
                total_currency: "USD",
                slices: [
                  {
                    origin: { iata_code: "JFK" },
                    destination: { iata_code: "LHR" },
                    duration: "PT7H30M",
                    segments: [
                      {
                        origin: { iata_code: "JFK" },
                        destination: { iata_code: "LHR" },
                        departing_at: "2026-06-15T09:00:00Z",
                        arriving_at: "2026-06-15T16:30:00Z",
                        operating_carrier: { iata_code: "BA" },
                        flight_number: "BA178",
                        duration: "PT7H30M",
                      },
                    ],
                  },
                ],
                passengers: [
                  {
                    id: "pas_offer_1",
                    given_name: "Tony",
                    family_name: "Stark",
                  },
                ],
                payment_status: {
                  awaiting_payment: body.data?.type === "hold",
                  payment_required_by: "2026-06-02T18:00:00Z",
                  price_guarantee_expires_at: "2026-06-01T18:00:00Z",
                },
                documents: [],
              },
            }),
          } as Response;
        }

        if (url.includes("/air/orders/ord_test_123")) {
          orderReadCount += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                id: "ord_test_123",
                booking_reference: "RZPNX8",
                total_amount: "299.50",
                total_currency: "USD",
                slices: [
                  {
                    origin: { iata_code: "JFK" },
                    destination: { iata_code: "LHR" },
                    duration: "PT7H30M",
                    segments: [
                      {
                        origin: { iata_code: "JFK" },
                        destination: { iata_code: "LHR" },
                        departing_at: "2026-06-15T09:00:00Z",
                        arriving_at: "2026-06-15T16:30:00Z",
                        operating_carrier: { iata_code: "BA" },
                        flight_number: "BA178",
                        duration: "PT7H30M",
                      },
                    ],
                  },
                ],
                passengers: [
                  {
                    id: "pas_offer_1",
                    given_name: "Tony",
                    family_name: "Stark",
                  },
                ],
                payment_status: {
                  awaiting_payment: orderReadCount === 1,
                  payment_required_by: "2026-06-02T18:00:00Z",
                  price_guarantee_expires_at: "2026-06-01T18:00:00Z",
                },
                documents:
                  orderReadCount === 1
                    ? []
                    : [
                        {
                          type: "electronic_ticket",
                          unique_identifier: "123-1230984567",
                        },
                      ],
              },
            }),
          } as Response;
        }

        if (url.endsWith("/air/payments")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                id: "pay_test_123",
                order_id: "ord_test_123",
                status: "succeeded",
                currency: "USD",
                amount: "299.50",
                type: "balance",
                created_at: "2026-06-01T12:00:00Z",
              },
            }),
          } as Response;
        }

        if (
          url.includes(
            "www.googleapis.com/calendar/v3/calendars/primary/events",
          )
        ) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            summary?: string;
            description?: string;
            location?: string;
            start?: { dateTime?: string; timeZone?: string };
            end?: { dateTime?: string; timeZone?: string };
          };
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: "google_evt_travel_1",
              status: "confirmed",
              summary: body.summary,
              description: body.description,
              location: body.location,
              htmlLink:
                "https://calendar.google.com/calendar/event?eid=travel_1",
              start: {
                dateTime: body.start?.dateTime,
                timeZone: body.start?.timeZone ?? TEST_TIME_ZONE,
              },
              end: {
                dateTime: body.end?.dateTime,
                timeZone: body.end?.timeZone ?? TEST_TIME_ZONE,
              },
            }),
          } as Response;
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

  originalFetch ??= globalThis.fetch;
  if (typeof vi.stubGlobal === "function") {
    vi.stubGlobal("fetch", fetchMock);
  } else {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  }
  return fetchMock;
}

function installApprovalResolutionModelStub(requestId: string, reason: string) {
  const originalUseModel = runtime.useModel.bind(runtime);
  runtime.useModel = (async (modelType, input) => {
    if (
      modelType === "TEXT_LARGE" &&
      typeof input === "object" &&
      input &&
      "prompt" in input &&
      typeof input.prompt === "string" &&
      input.prompt.includes("You are resolving an approval queue decision.")
    ) {
      return JSON.stringify({ requestId, reason });
    }
    return originalUseModel(modelType, input as never);
  }) as typeof runtime.useModel;
  return () => {
    runtime.useModel = originalUseModel;
  };
}

beforeAll(async () => {
  envBackup = saveEnv(
    "ELIZA_STATE_DIR",
    "DUFFEL_API_KEY",
    "ELIZA_DUFFEL_DIRECT",
  );
  stateDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "book-travel-approval-"),
  );
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.DUFFEL_API_KEY = "duffel-test-key";
  process.env.ELIZA_DUFFEL_DIRECT = "1";

  testRuntime = await createLifeOpsTestRuntime({
    characterName: "book-travel-test-agent",
  });
  runtime = testRuntime.runtime;
  await createFeatureFlagService(runtime).enable(
    "travel.book_flight",
    "local",
    String(runtime.agentId),
    { test: "book-travel approval integration" },
  );
  await seedGoogleWriteGrant();
}, 180_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
  await testRuntime.cleanup();
  await fs.promises.rm(stateDir, { recursive: true, force: true });
  envBackup.restore();
});

describe("BOOK_TRAVEL approval execution", () => {
  it("queues approval, books after approval, and syncs the itinerary to calendar", async () => {
    const fetchMock = installTravelAndCalendarFetchStub();
    const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });

    const queued = await runBookTravelHandler(
      runtime,
      ownerMessage("Book the JFK to LHR flight after I approve it."),
      {} as never,
      {
        parameters: {
          origin: "JFK",
          destination: "LHR",
          departureDate: "2026-06-15",
          passengers: [
            {
              givenName: "Tony",
              familyName: "Stark",
              bornOn: "1980-07-24",
              email: "tony@example.com",
              phoneNumber: "+15551234567",
            },
          ],
          calendarSync: {
            enabled: true,
            calendarId: "primary",
            title: "London flight",
            timeZone: TEST_TIME_ZONE,
          },
        },
      } as never,
      undefined,
    );

    expect(queued?.success).toBe(true);

    const pending = await queue.list({
      subjectUserId: String(runtime.agentId),
      state: "pending",
      action: "book_travel",
      limit: 10,
    });
    expect(pending).toHaveLength(1);
    const pendingRequest = pending[0];
    if (!pendingRequest) {
      throw new Error("Expected one pending travel approval request");
    }
    expect(pendingRequest.payload.action).toBe("book_travel");
    expect(String(queued?.text ?? "")).toContain("Queued travel approval for");
    expect(String(queued?.text ?? "")).not.toContain(pendingRequest.id);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/air/offer_requests"),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/air/offers/off_test_123"),
      ),
    ).toBe(true);

    const restoreModel = installApprovalResolutionModelStub(
      pendingRequest.id,
      "approve the London flight",
    );

    let approved: ActionResult | undefined;
    try {
      approved = await approveRequestAction.handler?.(
        runtime,
        ownerMessage("yes, approve that booking"),
        {} as never,
        {} as never,
        undefined,
      );
    } finally {
      restoreModel();
    }

    expect(approved?.success).toBe(true);
    expect(String(approved?.text ?? "")).toContain("Booked");

    const done = await queue.byId(pendingRequest.id);
    expect(done?.state).toBe("done");

    const repository = new LifeOpsRepository(runtime);
    const events = await repository.listCalendarEvents(
      String(runtime.agentId),
      "google",
      "2026-06-15T00:00:00.000Z",
      "2026-06-16T23:59:59.999Z",
      "owner",
    );
    expect(events.some((event) => event.title === "London flight")).toBe(true);

    const calledUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(calledUrls.some((url) => url.endsWith("/air/orders"))).toBe(true);
    expect(calledUrls.some((url) => url.endsWith("/air/payments"))).toBe(true);
    expect(
      calledUrls.some((url) =>
        url.includes("www.googleapis.com/calendar/v3/calendars/primary/events"),
      ),
    ).toBe(true);
  });

  it("rejects approval without executing order, payment, or calendar sync", async () => {
    const fetchMock = installTravelAndCalendarFetchStub();
    const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });

    const queued = await runBookTravelHandler(
      runtime,
      ownerMessage("Queue the next travel booking for approval."),
      {} as never,
      {
        parameters: {
          origin: "JFK",
          destination: "LHR",
          departureDate: "2026-06-15",
          passengers: [
            {
              givenName: "Tony",
              familyName: "Stark",
              bornOn: "1980-07-24",
            },
          ],
        },
      } as never,
      undefined,
    );

    expect(queued?.success).toBe(true);
    const pending = await queue.list({
      subjectUserId: String(runtime.agentId),
      state: "pending",
      action: "book_travel",
      limit: 10,
    });
    expect(pending.length).toBeGreaterThan(0);
    const pendingRequest = pending[0];
    if (!pendingRequest) {
      throw new Error("Expected at least one pending travel approval request");
    }

    const callCountBeforeReject = fetchMock.mock.calls.length;
    const restoreModel = installApprovalResolutionModelStub(
      pendingRequest.id,
      "reject the London flight",
    );
    let rejected: ActionResult | undefined;
    try {
      rejected = await rejectRequestAction.handler?.(
        runtime,
        ownerMessage("reject that travel booking"),
        {} as never,
        {} as never,
        undefined,
      );
    } finally {
      restoreModel();
    }

    expect(rejected?.success).toBe(true);
    expect(fetchMock.mock.calls).toHaveLength(callCountBeforeReject);

    const latest = await queue.byId(pendingRequest.id);
    expect(latest?.state).toBe("rejected");
  });
});
