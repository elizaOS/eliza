import { describe, expect, test } from "bun:test";
import {
  admitSpeechHostCutover,
  fetchSpeechNamespaces,
} from "./speech-host-cutover-admission.mjs";

const now = Date.parse("2026-11-08T16:00:00.000Z");
const oldId = "b".repeat(32);
const newId = "c".repeat(32);
const sourceSha = "d".repeat(40);
const oldWorker = "eliza-cloud-api-staging";
const newWorker = "eliza-cloud-speech-staging";
const namespaces = [
  { id: oldId, class: "SpeechRelayCoordinator", script: oldWorker },
  { id: newId, class: "SpeechRelayCoordinator", script: newWorker },
];
const attestation = {
  version: 1,
  sourceSha,
  fromWorker: oldWorker,
  fromNamespaceId: oldId,
  toWorker: newWorker,
  toNamespaceId: newId,
  issuedAt: "2026-11-08T15:59:00.000Z",
  expiresAt: "2026-11-08T16:10:00.000Z",
  legacySessionsDrained: true,
  legacyAdmissionHeld: true,
  evidence: "controlled staging drain receipt",
};
const environment = {
  DEPLOY_ENVIRONMENT: "staging",
  GITHUB_SHA: sourceSha,
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_API_TOKEN: "local-fixture-token",
  STAGING_SPEECH_CUTOVER_ATTESTATION: JSON.stringify(attestation),
};
const speech = (id: string) => ({
  name: "SPEECH_RELAY_SESSIONS",
  type: "durable_object_namespace",
  namespace_id: id,
});
const freeze = {
  name: "VOICE_SPEECH_RELAY_ENABLED",
  type: "plain_text",
  text: "false",
};

function fixture(
  options: {
    api?: unknown[];
    target?: unknown[];
    pages?: unknown[];
    status?: number;
  } = {},
) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url));
    const page = Number(path.searchParams.get("page"));
    calls.push(path.pathname + path.search);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBe("Bearer local-fixture-token");
    const body = path.pathname.endsWith(`/scripts/${oldWorker}/settings`)
      ? { result: { bindings: options.api ?? [speech(oldId), freeze] } }
      : path.pathname.endsWith(`/scripts/${newWorker}/settings`)
        ? { result: { bindings: options.target ?? [speech(newId)] } }
        : ((options.pages ?? [
            {
              result: namespaces,
              result_info: {
                page: 1,
                per_page: 1000,
                count: 2,
                total_count: 2,
              },
            },
          ])[page - 1] ?? {
            result: [],
            result_info: { page, count: 0 },
          });
    return new Response(JSON.stringify({ success: true, ...body }), {
      status: options.status ?? 200,
    });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("staging speech host cutover admission", () => {
  test("retains the live API namespace without provisioning, freezing or attesting a cutover", async () => {
    const { calls, fetcher } = fixture({
      api: [speech(oldId)],
      pages: [
        {
          result: [namespaces[0]],
          result_info: {
            page: 1,
            per_page: 1000,
            count: 1,
            total_pages: 1,
            total_count: 1,
          },
        },
      ],
    });
    const retained = {
      ...environment,
      STAGING_SPEECH_HOST: "api",
      STAGING_SPEECH_CUTOVER_ATTESTATION: "",
    };
    const missingTarget = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(url)).not.toContain(`/scripts/${newWorker}/settings`);
      return fetcher(url, init);
    }) as typeof fetch;
    const result = await admitSpeechHostCutover(retained, missingTarget);
    expect(result).toEqual({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      alreadyActive: true,
    });
    expect(calls).toEqual([
      `/client/v4/accounts/${"a".repeat(32)}/workers/scripts/${oldWorker}/settings`,
      `/client/v4/accounts/${"a".repeat(32)}/workers/durable_objects/namespaces?page=1&per_page=1000`,
      `/client/v4/accounts/${"a".repeat(32)}/workers/durable_objects/namespaces?page=2&per_page=1000`,
    ]);
    expect(
      await admitSpeechHostCutover(
        {
          ...retained,
          SPEECH_CUTOVER_EXPECTED_FINGERPRINT: result.fingerprint,
        },
        missingTarget,
      ),
    ).toEqual(result);
    await expect(
      admitSpeechHostCutover(
        {
          ...retained,
          GITHUB_SHA: "e".repeat(40),
          SPEECH_CUTOVER_EXPECTED_FINGERPRINT: result.fingerprint,
        },
        missingTarget,
      ),
    ).rejects.toThrow("cutover_identity_changed");
  });

  test("API retention rejects a reverse cutover from the live speech namespace", async () => {
    await expect(
      admitSpeechHostCutover(
        { ...environment, STAGING_SPEECH_HOST: "api" },
        fixture({ api: [speech(newId)] }).fetcher,
      ),
    ).rejects.toThrow("api_retention_requires_local_namespace");
  });

  test("API retention rechecks the exact namespace before publishing", async () => {
    const retained = { ...environment, STAGING_SPEECH_HOST: "api" };
    const first = await admitSpeechHostCutover(retained, fixture().fetcher);
    const replacement = "f".repeat(32);
    await expect(
      admitSpeechHostCutover(
        {
          ...retained,
          SPEECH_CUTOVER_EXPECTED_FINGERPRINT: first.fingerprint,
        },
        fixture({
          api: [speech(replacement)],
          pages: [
            {
              result: [{ ...namespaces[0], id: replacement }],
              result_info: {
                page: 1,
                per_page: 1000,
                count: 1,
                total_pages: 1,
                total_count: 1,
              },
            },
          ],
        }).fetcher,
      ),
    ).rejects.toThrow("cutover_identity_changed");
  });

  test.each(["", "API", "other"])(
    "rejects an invalid desired host %s before provider reads",
    async (host) => {
      const { calls, fetcher } = fixture();
      await expect(
        admitSpeechHostCutover(
          { ...environment, STAGING_SPEECH_HOST: host },
          fetcher,
        ),
      ).rejects.toThrow("invalid_desired_host");
      expect(calls).toEqual([]);
    },
  );

  test("reads actual Worker/namespace metadata and admits the frozen, attested first switch", async () => {
    const { calls, fetcher } = fixture();
    const result = await admitSpeechHostCutover(
      environment,
      fetcher,
      () => now,
    );
    expect(result).toEqual({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      alreadyActive: false,
    });
    expect(calls).toEqual([
      `/client/v4/accounts/${"a".repeat(32)}/workers/scripts/${oldWorker}/settings`,
      `/client/v4/accounts/${"a".repeat(32)}/workers/scripts/${newWorker}/settings`,
      `/client/v4/accounts/${"a".repeat(32)}/workers/durable_objects/namespaces?page=1&per_page=1000`,
      `/client/v4/accounts/${"a".repeat(32)}/workers/durable_objects/namespaces?page=2&per_page=1000`,
    ]);
    expect(
      await admitSpeechHostCutover(
        {
          ...environment,
          SPEECH_CUTOVER_EXPECTED_FINGERPRINT: result.fingerprint,
        },
        fetcher,
        () => now + 1,
      ),
    ).toEqual(result);
  });

  test("expiry is checked after inventory I/O crosses the deadline", async () => {
    const { fetcher } = fixture();
    let decisionTime = now;
    const delayed = (async (...args: Parameters<typeof fetch>) => {
      const response = await fetcher(...args);
      decisionTime = now + 11 * 60_000;
      return response;
    }) as typeof fetch;
    await expect(
      admitSpeechHostCutover(environment, delayed, () => decisionTime),
    ).rejects.toThrow("attestation_expired_or_invalid");
  });

  test("an unprovisioned target blocks activation with a host-only bootstrap instruction", async () => {
    const { fetcher, calls } = fixture();
    const missingTarget = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(url).includes(`/scripts/${newWorker}/settings`)) {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10007, message: "private provider detail" }],
          }),
          { status: 404 },
        );
      }
      return fetcher(url, init);
    }) as typeof fetch;
    let message = "";
    try {
      await admitSpeechHostCutover(environment, missingTarget, () => now);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      "complete host-only provisioning before first activation",
    );
    expect(message).toContain("HTTP 404");
    expect(message).not.toContain("private provider detail");
    expect(calls).toHaveLength(1);
  });

  test("already active updates require no new freeze or attestation", async () => {
    const { fetcher } = fixture({ api: [speech(newId)] });
    const result = await admitSpeechHostCutover(
      { ...environment, STAGING_SPEECH_CUTOVER_ATTESTATION: "" },
      fetcher,
      () => now,
    );
    expect(result.alreadyActive).toBe(true);
    const old = await admitSpeechHostCutover(
      environment,
      fixture().fetcher,
      () => now,
    );
    await expect(
      admitSpeechHostCutover(
        {
          ...environment,
          SPEECH_CUTOVER_EXPECTED_FINGERPRINT: old.fingerprint,
        },
        fetcher,
        () => now,
      ),
    ).rejects.toThrow("cutover_identity_changed");
  });

  test.each([
    ["missing", ""],
    ["malformed", "{"],
    [
      "different source",
      JSON.stringify({ ...attestation, sourceSha: "e".repeat(40) }),
    ],
    [
      "different old namespace",
      JSON.stringify({ ...attestation, fromNamespaceId: newId }),
    ],
    [
      "different target",
      JSON.stringify({ ...attestation, toWorker: oldWorker }),
    ],
    [
      "point-in-time drain only",
      JSON.stringify({ ...attestation, legacyAdmissionHeld: false }),
    ],
    [
      "not drained",
      JSON.stringify({ ...attestation, legacySessionsDrained: false }),
    ],
    ["unknown field", JSON.stringify({ ...attestation, extra: true })],
    [
      "expired",
      JSON.stringify({ ...attestation, expiresAt: "2026-11-08T16:00:00.000Z" }),
    ],
    [
      "future",
      JSON.stringify({ ...attestation, issuedAt: "2026-11-08T16:01:00.000Z" }),
    ],
    [
      "overlong",
      JSON.stringify({ ...attestation, expiresAt: "2026-11-09T16:00:00.000Z" }),
    ],
  ])("rejects %s attestation", async (_name, value) => {
    await expect(
      admitSpeechHostCutover(
        { ...environment, STAGING_SPEECH_CUTOVER_ATTESTATION: value },
        fixture().fetcher,
        () => now,
      ),
    ).rejects.toThrow("speech_cutover:");
  });

  test("rechecks expiration, admission thaw, identity drift and protected environment", async () => {
    const first = await admitSpeechHostCutover(
      environment,
      fixture().fetcher,
      () => now,
    );
    const finalEnv = {
      ...environment,
      SPEECH_CUTOVER_EXPECTED_FINGERPRINT: first.fingerprint,
    };
    await expect(
      admitSpeechHostCutover(
        finalEnv,
        fixture().fetcher,
        () => now + 11 * 60_000,
      ),
    ).rejects.toThrow("attestation_expired");
    await expect(
      admitSpeechHostCutover(
        finalEnv,
        fixture({ api: [speech(oldId), { ...freeze, text: "true" }] }).fetcher,
        () => now,
      ),
    ).rejects.toThrow("legacy_admission_not_frozen");
    await expect(
      admitSpeechHostCutover(
        { ...finalEnv, SPEECH_CUTOVER_EXPECTED_FINGERPRINT: "" },
        fixture().fetcher,
        () => now,
      ),
    ).rejects.toThrow("cutover_identity_changed");
    await expect(
      admitSpeechHostCutover(
        { ...environment, DEPLOY_ENVIRONMENT: "production" },
        fixture().fetcher,
        () => now,
      ),
    ).rejects.toThrow("invalid_release_identity");
  });

  test.each([
    { api: [speech(oldId), speech(oldId), freeze] },
    { api: [{ ...speech(oldId), class_name: "Other" }, freeze] },
    { api: [{ ...speech(oldId), script_name: newWorker }, freeze] },
    { api: [{ ...speech(oldId), environment: "legacy" }, freeze] },
    { api: [{ ...speech(oldId), dispatch_namespace: "other" }, freeze] },
    { target: [speech(oldId)] },
    {
      api: [speech(oldId), { ...freeze, type: "secret_text", text: undefined }],
    },
    { api: [speech(oldId)] },
  ])(
    "rejects ambiguous or unexpected ownership/authority %#",
    async (options) => {
      await expect(
        admitSpeechHostCutover(
          environment,
          fixture(options).fetcher,
          () => now,
        ),
      ).rejects.toThrow("speech_cutover:");
    },
  );

  test("resolves omitted namespace IDs only from unique owner/class inventory", async () => {
    const binding = {
      name: "SPEECH_RELAY_SESSIONS",
      type: "durable_object_namespace",
      class_name: "SpeechRelayCoordinator",
    };
    const result = await admitSpeechHostCutover(
      environment,
      fixture({ api: [binding, freeze], target: [binding] }).fetcher,
      () => now,
    );
    expect(result.alreadyActive).toBe(false);
  });

  test("accepts the live Cloudflare pagination shape without total_pages", async () => {
    const { calls, fetcher } = fixture({
      pages: [
        {
          result: namespaces,
          result_info: { page: 1, per_page: 1000, count: 2, total_count: 2 },
        },
        {
          result: [],
          result_info: { page: 2, per_page: 1000, count: 0, total_count: 2 },
        },
      ],
    });
    expect(await fetchSpeechNamespaces(environment, fetcher)).toEqual(
      namespaces,
    );
    expect(calls).toHaveLength(2);
  });

  test("reads short pages through the empty terminal page when metadata is absent", async () => {
    const { calls, fetcher } = fixture({
      pages: [
        { result: [namespaces[0]] },
        { result: [namespaces[1]] },
        { result: [] },
      ],
    });
    expect(await fetchSpeechNamespaces(environment, fetcher)).toEqual(
      namespaces,
    );
    expect(calls).toHaveLength(3);
  });

  test("rejects malformed results and supplied pagination metadata", async () => {
    for (const body of [
      {},
      { result: null },
      { result: {} },
      { result: namespaces, result_info: null },
      { result: namespaces, result_info: [] },
      { result: namespaces, result_info: { page: 2 } },
      { result: namespaces, result_info: { count: 1 } },
      { result: namespaces, result_info: { total_count: -1 } },
      { result: namespaces, result_info: { total_pages: "1" } },
      { result: namespaces, result_info: { per_page: 1 } },
      { result: namespaces, result_info: { per_page: 1001 } },
    ])
      await expect(
        fetchSpeechNamespaces(environment, fixture({ pages: [body] }).fetcher),
      ).rejects.toThrow("incomplete_namespace_inventory");
  });

  test("reads every namespace page and rejects incomplete/duplicate inventories", async () => {
    const page = (number: number, result: unknown[]) => ({
      result,
      result_info: {
        page: number,
        per_page: 1,
        count: result.length,
        total_pages: 2,
        total_count: 2,
      },
    });
    const { fetcher, calls } = fixture({
      pages: [page(1, [namespaces[0]]), page(2, [namespaces[1]])],
    });
    expect(await fetchSpeechNamespaces(environment, fetcher)).toEqual(
      namespaces,
    );
    expect(calls).toHaveLength(3);
    for (const pages of [
      [page(1, [namespaces[0]]), page(2, [namespaces[0]])],
      [
        page(1, [namespaces[0]]),
        {
          ...page(2, []),
          result_info: { ...page(2, []).result_info, total_count: 3 },
        },
      ],
      [
        page(1, [namespaces[0]]),
        {
          ...page(2, [namespaces[1]]),
          result_info: { ...page(2, []).result_info, count: 1, total_pages: 3 },
        },
      ],
      [
        page(1, [namespaces[0]]),
        {
          ...page(2, [namespaces[1]]),
          result_info: { ...page(2, []).result_info, count: 1, per_page: 2 },
        },
      ],
      [page(1, [namespaces[0]]), page(2, [])],
      [
        {
          result: [namespaces[0]],
          result_info: { page: 1, per_page: 1, count: 1 },
        },
        {
          result: [namespaces[1], { ...namespaces[0], id: "e".repeat(32) }],
        },
      ],
      [{ result: namespaces, result_info: { total_count: 3 } }, { result: [] }],
      [{ result: namespaces, result_info: { total_pages: 2 } }, { result: [] }],
    ])
      await expect(
        fetchSpeechNamespaces(environment, fixture({ pages }).fetcher),
      ).rejects.toThrow("speech_cutover:");
  });

  test("refuses an inventory that never terminates within the page budget", async () => {
    const { fetcher, calls } = fixture({
      pages: Array.from({ length: 100 }, (_, index) => ({
        result: [
          {
            ...namespaces[0],
            id: (index + 1).toString(16).padStart(32, "0"),
          },
        ],
      })),
    });
    await expect(fetchSpeechNamespaces(environment, fetcher)).rejects.toThrow(
      "namespace_inventory_page_limit",
    );
    expect(calls).toHaveLength(100);
  });

  test("provider failures do not reveal protected input", async () => {
    await expect(
      admitSpeechHostCutover(
        environment,
        fixture({ status: 403 }).fetcher,
        () => now,
      ),
    ).rejects.toThrow("HTTP 403");
  });
});
