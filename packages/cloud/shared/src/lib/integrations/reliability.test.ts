/**
 * Unit tests for the integration reliability read-model: real contract,
 * deterministic, no mocks. Covers validation/invalid input, redaction audit,
 * idempotent recording and eviction, kill-switch/evidence config sanitizing,
 * SLO health classification, stale sync, cost/latency aggregation, and the
 * no-secrets guarantee on the full dashboard payload.
 */
import { describe, expect, test } from "bun:test";
import {
  buildIntegrationReliabilityDashboard,
  DEFAULT_INTEGRATION_SLO,
  findSecretLeaksInPayload,
  type IntegrationTelemetryEvent,
  IntegrationTelemetryRecorder,
  IntegrationTelemetryValidationError,
  PRODUCTION_INTEGRATION_RUNBOOK,
  parseIntegrationKillSwitches,
  parseIntegrationReleaseEvidence,
  parseIntegrationTelemetryEvent,
  redactIntegrationDiagnostics,
} from "./reliability";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function event(
  overrides: Partial<IntegrationTelemetryEvent> & { id: string },
): IntegrationTelemetryEvent {
  return parseIntegrationTelemetryEvent({
    provider: "plaid",
    kind: "capability_call",
    outcome: "success",
    occurredAt: "2026-08-20T11:59:00.000Z",
    ...overrides,
  });
}

describe("parseIntegrationTelemetryEvent", () => {
  test("normalizes a full valid event", () => {
    const parsed = event({
      id: "e1",
      capability: "transactions.sync",
      latencyMs: 120,
      costMicros: 250,
      code: "ok",
      detail: "synced 12 accounts",
    });
    expect(parsed.provider).toBe("plaid");
    expect(parsed.capability).toBe("transactions.sync");
    expect(parsed.latencyMs).toBe(120);
    expect(parsed.costMicros).toBe(250);
    expect(parsed.occurredAt).toBe("2026-08-20T11:59:00.000Z");
  });

  test.each([
    [{}, "invalid_field"],
    [
      {
        id: "x",
        provider: "Bad Slug!",
        kind: "capability_call",
        outcome: "success",
        occurredAt: NOW.toISOString(),
      },
      "invalid_provider",
    ],
    [
      {
        id: "x",
        provider: "plaid",
        kind: "nope",
        outcome: "success",
        occurredAt: NOW.toISOString(),
      },
      "invalid_kind",
    ],
    [
      {
        id: "x",
        provider: "plaid",
        kind: "capability_call",
        outcome: "maybe",
        occurredAt: NOW.toISOString(),
      },
      "invalid_outcome",
    ],
    [
      {
        id: "x",
        provider: "plaid",
        kind: "capability_call",
        outcome: "success",
        occurredAt: "not-a-date",
      },
      "invalid_occurred_at",
    ],
    [
      {
        id: "x",
        provider: "plaid",
        kind: "capability_call",
        outcome: "success",
        occurredAt: NOW.toISOString(),
        latencyMs: -5,
      },
      "invalid_field",
    ],
    ["not-an-object", "invalid_event"],
  ])("rejects malformed input %#", (input, code) => {
    try {
      parseIntegrationTelemetryEvent(input);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationTelemetryValidationError);
      expect((error as IntegrationTelemetryValidationError).code).toBe(code);
    }
  });

  test("redacts secret-shaped detail and code on ingest", () => {
    const parsed = event({
      id: "e2",
      outcome: "failure",
      kind: "oauth_error",
      code: "token_refresh_failed Bearer abcdefghijklmnop",
      detail:
        "refresh for user shaw@example.com failed with sk-abcdef1234567890 api_key=supersecretvalue",
    });
    expect(parsed.code).not.toContain("Bearer abcdefghijklmnop");
    expect(parsed.detail).not.toContain("shaw@example.com");
    expect(parsed.detail).not.toContain("sk-abcdef1234567890");
    expect(parsed.detail).not.toContain("supersecretvalue");
    expect(parsed.detail).toContain("[redacted]");
  });
});

describe("redaction", () => {
  test("redactIntegrationDiagnostics strips common credential shapes", () => {
    const input =
      "AKIAABCDEFGHIJKLMNOP ghp_ABCDEFGHIJKLMNOPQRSTuvwx eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0 password=hunter22 deadbeefdeadbeefdeadbeefdeadbeef";
    const out = redactIntegrationDiagnostics(input);
    expect(out).not.toContain("AKIA");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("eyJ");
    expect(out).not.toContain("hunter22");
    expect(out).not.toContain("deadbeefdeadbeef");
  });

  test("findSecretLeaksInPayload flags leaks and passes clean payloads", () => {
    expect(findSecretLeaksInPayload({ note: "all good", n: 3 })).toEqual([]);
    const leaks = findSecretLeaksInPayload({
      nested: { token: "Bearer abcdefghijklmnop" },
    });
    expect(leaks.length).toBeGreaterThan(0);
  });
});

describe("IntegrationTelemetryRecorder", () => {
  test("is idempotent per event id", () => {
    const recorder = new IntegrationTelemetryRecorder();
    const input = {
      id: "dup-1",
      provider: "gmail",
      kind: "webhook_error",
      outcome: "failure",
      occurredAt: NOW.toISOString(),
    };
    expect(recorder.record(input).recorded).toBe(true);
    expect(recorder.record(input).recorded).toBe(false);
    expect(recorder.size).toBe(1);
  });

  test("evicts oldest events beyond capacity", () => {
    const recorder = new IntegrationTelemetryRecorder({ capacity: 2 });
    for (const id of ["a", "b", "c"]) {
      recorder.record({
        id,
        provider: "gmail",
        kind: "capability_call",
        outcome: "success",
        occurredAt: NOW.toISOString(),
      });
    }
    expect(recorder.size).toBe(2);
    expect(recorder.snapshot().map((e) => e.id)).toEqual(["b", "c"]);
  });

  test("rejects invalid capacity and invalid events", () => {
    expect(() => new IntegrationTelemetryRecorder({ capacity: 0 })).toThrow(
      IntegrationTelemetryValidationError,
    );
    const recorder = new IntegrationTelemetryRecorder();
    expect(() => recorder.record({ id: "x" })).toThrow(IntegrationTelemetryValidationError);
    expect(recorder.size).toBe(0);
  });
});

describe("kill-switch and evidence config parsing", () => {
  test("empty config yields no switches and no invalids", () => {
    expect(parseIntegrationKillSwitches(undefined)).toEqual({
      switches: [],
      invalid: [],
    });
    expect(parseIntegrationKillSwitches("  ")).toEqual({
      switches: [],
      invalid: [],
    });
  });

  test("malformed JSON is an explicit invalid result", () => {
    expect(parseIntegrationKillSwitches("{oops").invalid).toEqual(["config_not_json"]);
    expect(parseIntegrationKillSwitches('{"a":1}').invalid).toEqual(["config_not_array"]);
    expect(parseIntegrationReleaseEvidence("nope").invalid).toEqual(["config_not_json"]);
  });

  test("mixed valid/invalid entries are split, not silently dropped", () => {
    const result = parseIntegrationKillSwitches(
      JSON.stringify([
        { provider: "plaid", reason: "incident 42", capability: "transfers" },
        { provider: "BAD!", reason: "x" },
        { provider: "gmail" },
        7,
      ]),
    );
    expect(result.switches).toHaveLength(1);
    expect(result.switches[0]).toMatchObject({
      provider: "plaid",
      capability: "transfers",
      reason: "incident 42",
    });
    expect(result.invalid).toEqual([
      "entry_1_invalid_provider",
      "entry_2_missing_reason",
      "entry_3_not_object",
    ]);
  });

  test("release evidence validates status and normalizes timestamps", () => {
    const result = parseIntegrationReleaseEvidence(
      JSON.stringify([
        {
          provider: "plaid",
          status: "verified",
          reference: "elizaOS/eliza#19908",
          verifiedAt: "2026-08-01T00:00:00Z",
        },
        { provider: "gmail", status: "wat" },
      ]),
    );
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].verifiedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(result.invalid).toEqual(["entry_1_invalid_status"]);
  });
});

describe("buildIntegrationReliabilityDashboard", () => {
  test("classifies healthy, degraded, down, disabled, and unknown providers", () => {
    const events: IntegrationTelemetryEvent[] = [];
    // healthy: 20 successes, low latency
    for (let i = 0; i < 20; i++) {
      events.push(event({ id: `h${i}`, provider: "gmail", latencyMs: 100 + i }));
    }
    // down: 3 of 4 failures
    for (let i = 0; i < 4; i++) {
      events.push(
        event({
          id: `d${i}`,
          provider: "plaid",
          outcome: i === 0 ? "success" : "failure",
          kind: i === 1 ? "oauth_error" : "capability_call",
        }),
      );
    }
    // degraded via latency: successes but slow p95
    for (let i = 0; i < 10; i++) {
      events.push(
        event({
          id: `l${i}`,
          provider: "google-maps",
          latencyMs: i < 9 ? 100 : 20000,
        }),
      );
    }
    const dashboard = buildIntegrationReliabilityDashboard({
      events,
      killSwitches: [
        {
          provider: "stripe",
          capability: null,
          reason: "incident",
          actor: "ops",
          activatedAt: null,
        },
      ],
      evidence: [
        {
          provider: "gmail",
          status: "verified",
          reference: "#19908",
          verifiedAt: NOW.toISOString(),
        },
        { provider: "notion", status: "pending", reference: null, verifiedAt: null },
      ],
      now: NOW,
    });
    const byName = Object.fromEntries(dashboard.providers.map((p) => [p.provider, p]));
    expect(byName.gmail.health).toBe("healthy");
    expect(byName.plaid.health).toBe("down");
    expect(byName.plaid.totals.errorRate).toBeCloseTo(0.75);
    expect(byName.plaid.counts.oauthErrors).toBe(1);
    expect(byName["google-maps"].health).toBe("degraded");
    expect(byName["google-maps"].latency.p95Ms).toBe(20000);
    expect(byName.stripe.health).toBe("disabled");
    expect(byName.notion.health).toBe("unknown");
    // alerts
    const codesFor = (p: string) =>
      dashboard.alerts.filter((a) => a.provider === p).map((a) => a.code);
    expect(codesFor("plaid")).toContain("error_rate_down");
    expect(codesFor("google-maps")).toContain("latency_p95_breach");
    expect(codesFor("stripe")).toContain("kill_switch_active");
    expect(codesFor("plaid")).toContain("evidence_missing");
    expect(codesFor("gmail")).not.toContain("evidence_missing");
  });

  test("detects stale sync only for providers with a sync surface", () => {
    const events = [
      event({
        id: "s1",
        provider: "notion",
        kind: "sync_completed",
        occurredAt: "2026-08-19T00:00:00.000Z",
      }),
      event({ id: "s2", provider: "gmail" }),
    ];
    const dashboard = buildIntegrationReliabilityDashboard({
      events,
      now: NOW,
    });
    const notion = dashboard.providers.find((p) => p.provider === "notion");
    const gmail = dashboard.providers.find((p) => p.provider === "gmail");
    expect(notion?.syncStale).toBe(true);
    expect(notion?.health).toBe("degraded");
    expect(notion?.lastSyncAt).toBe("2026-08-19T00:00:00.000Z");
    expect(gmail?.syncStale).toBe(false);
    expect(dashboard.alerts.some((a) => a.provider === "notion" && a.code === "stale_sync")).toBe(
      true,
    );
  });

  test("aggregates cost and counts policy denies and reauth demands", () => {
    const events = [
      event({ id: "c1", provider: "plaid", costMicros: 100 }),
      event({ id: "c2", provider: "plaid", costMicros: 250 }),
      event({
        id: "c3",
        provider: "plaid",
        kind: "policy_deny",
        outcome: "failure",
        code: "risk_confirmation_required",
      }),
      event({
        id: "c4",
        provider: "plaid",
        kind: "reauth_required",
        outcome: "failure",
      }),
      event({
        id: "c5",
        provider: "plaid",
        kind: "kill_switch_block",
        outcome: "failure",
      }),
    ];
    const dashboard = buildIntegrationReliabilityDashboard({
      events,
      now: NOW,
    });
    const plaid = dashboard.providers[0];
    expect(plaid.costMicros).toBe(350);
    expect(plaid.counts.policyDenies).toBe(1);
    expect(plaid.counts.reauthRequired).toBe(1);
    expect(plaid.counts.killSwitchBlocks).toBe(1);
  });

  test("empty input yields a designed-empty dashboard, not a failure", () => {
    const dashboard = buildIntegrationReliabilityDashboard({
      events: [],
      now: NOW,
    });
    expect(dashboard.providers).toEqual([]);
    expect(dashboard.alerts).toEqual([]);
    expect(dashboard.slo).toEqual(DEFAULT_INTEGRATION_SLO);
    expect(dashboard.generatedAt).toBe(NOW.toISOString());
  });

  test("redaction audit: full dashboard built from hostile input has no secrets", () => {
    const recorder = new IntegrationTelemetryRecorder();
    recorder.record({
      id: "hostile-1",
      provider: "plaid",
      kind: "oauth_error",
      outcome: "failure",
      occurredAt: NOW.toISOString(),
      code: "refresh_failed token=sk-verysecretkey1234567890",
      detail: "user victim@example.com Bearer aaaaaaaaaaaaaaaaaaaa ghp_ABCDEFGHIJKLMNOPQRSTUV",
    });
    const dashboard = buildIntegrationReliabilityDashboard({
      events: recorder.snapshot(),
      killSwitches: parseIntegrationKillSwitches(
        JSON.stringify([
          {
            provider: "plaid",
            reason: "leaked key sk-anothersecret12345678 rotate",
          },
        ]),
      ).switches,
      now: NOW,
    });
    expect(
      findSecretLeaksInPayload({
        dashboard,
        runbook: PRODUCTION_INTEGRATION_RUNBOOK,
      }),
    ).toEqual([]);
  });
});
