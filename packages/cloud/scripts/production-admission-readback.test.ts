/** Fixtures for the production admission readback; no Cloudflare calls. */
import { describe, expect, test } from "bun:test";
import {
  type CloudflareRead,
  KNOWN_EXTERNAL_CONSUMERS,
  LIVE_PHASES,
  type LivePhase,
  listNamespaces,
  PRODUCTION_ADMISSION_NAMESPACE_ID as NPROD,
  parseObjectSample,
  type Receipt,
  requirePhaseContinuity,
  verifyObjectSample,
  verifyProductionAdmission,
} from "./production-admission-readback.ts";

const API = "eliza-cloud-api-prod";
const TARGET = "eliza-cloud-admission-prod";
const DIAG = KNOWN_EXTERNAL_CONSUMERS[0].script;
const GATE = "InferenceAdmissionGate";
const PHASES = Object.keys(LIVE_PHASES) as LivePhase[];

type Binding = Record<string, unknown>;
interface World {
  namespaces: Record<string, unknown>[];
  namespacePage?: (
    page: number,
    items: Record<string, unknown>[],
  ) => Awaited<ReturnType<CloudflareRead>>;
  scripts: Record<string, { version: string; bindings: Binding[] }>;
  objects: { id: string; hasStoredData: boolean }[];
  objectPageSize: number;
}

const gate = (scriptName?: string): Binding => ({
  name: "INFERENCE_ADMISSION_GATES",
  type: "durable_object_namespace",
  class_name: GATE,
  namespace_id: NPROD,
  ...(scriptName ? { script_name: scriptName } : {}),
});
const text = (name: string, value: string): Binding => ({
  name,
  type: "plain_text",
  text: value,
});
const flags = () => [
  text("ENVIRONMENT", "production"),
  text("INFERENCE_STRONG_REVOCATION_ENABLED", "false"),
  text("VOICE_SPEECH_RELAY_ENABLED", "true"),
];
const hex = (value: number, length: number) =>
  value.toString(16).padStart(length, "0");

function world(phase: LivePhase): World {
  const live = LIVE_PHASES[phase];
  const scripts: World["scripts"] = {
    [API]: {
      version: "api-v1",
      bindings: [
        gate(live.apiGate === "target" ? TARGET : undefined),
        ...flags(),
        text("ELIZA_DEPLOY_COMMIT", "a".repeat(40)),
      ],
    },
    [DIAG]: {
      version: "diag-v1",
      bindings: [
        {
          name: "PRODUCTION",
          type: "durable_object_namespace",
          class_name: GATE,
          namespace_id: NPROD,
          script_name: API,
        },
      ],
    },
    // Staging binds its own namespace of the same class; it is not a consumer.
    "eliza-cloud-admission-staging": {
      version: "staging-v1",
      bindings: [{ ...gate(), namespace_id: "f".repeat(32) }],
    },
  };
  if (live.target !== "absent")
    scripts[TARGET] = {
      version: "target-v1",
      bindings: [
        ...(live.target === "bound" ? [gate()] : []),
        {
          name: "INFERENCE_RECOVERY_SERVICE",
          type: "service",
          service: API,
          entrypoint: "InferenceRecoveryService",
        },
        ...flags(),
        text("ELIZA_DEPLOY_COMMIT", "b".repeat(40)),
      ],
    };
  return {
    namespaces: [
      {
        id: NPROD,
        class: GATE,
        script: live.owner === "api" ? API : TARGET,
        use_sqlite: true,
      },
      ...Array.from({ length: 120 }, (_, index) => ({
        id: hex(index, 32),
        class: "OtherClass",
        script: `worker-${index}`,
        use_sqlite: true,
      })),
    ],
    scripts,
    objects: Array.from({ length: 30 }, (_, index) => ({
      id: hex(index, 64),
      hasStoredData: index % 3 !== 0,
    })),
    objectPageSize: 7,
  };
}

function reader(state: World, calls: string[] = []): CloudflareRead {
  return async (path) => {
    calls.push(path);
    const url = new URL(path, "https://cloudflare.invalid");
    if (url.pathname === "/workers/durable_objects/namespaces") {
      const page = Number(url.searchParams.get("page"));
      const size = Number(url.searchParams.get("per_page"));
      const items = state.namespaces.slice((page - 1) * size, page * size);
      return (
        state.namespacePage?.(page, items) ?? {
          result: items,
          result_info: {
            page,
            per_page: size,
            count: items.length,
            total_count: state.namespaces.length,
          },
        }
      );
    }
    if (
      url.pathname === `/workers/durable_objects/namespaces/${NPROD}/objects`
    ) {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const items = state.objects.slice(start, start + state.objectPageSize);
      const next = start + items.length;
      return {
        result: items,
        result_info: {
          count: items.length,
          ...(next < state.objects.length ? { cursor: String(next) } : {}),
        },
      };
    }
    if (url.pathname === "/workers/scripts")
      return { result: Object.keys(state.scripts).map((id) => ({ id })) };
    const match = url.pathname.match(
      /^\/workers\/scripts\/([^/]+)\/(deployments|settings|versions\/(.+))$/,
    );
    const worker = match && state.scripts[match[1]];
    if (!match || !worker)
      throw new Error(`Cloudflare readback failed (HTTP 404): ${path}`);
    if (match[2] === "deployments")
      return {
        result: {
          deployments: [
            {
              created_on: "2026-11-01T00:00:00Z",
              versions: [{ version_id: worker.version, percentage: 100 }],
            },
          ],
        },
      };
    if (match[2] === "settings")
      return { result: { bindings: worker.bindings } };
    return {
      result:
        match[3] === worker.version
          ? { id: worker.version, resources: { bindings: worker.bindings } }
          : undefined,
    };
  };
}

const verify = (
  state: World,
  phase: LivePhase,
  extra: Partial<Parameters<typeof verifyProductionAdmission>[1]> = {},
) =>
  verifyProductionAdmission(reader(state), {
    api: API,
    target: TARGET,
    phase,
    inventory: true,
    ...extra,
  });

describe("namespace pagination fails closed", () => {
  test("a complete multi-page listing is accepted", async () => {
    const state = world("adopted");
    const calls: string[] = [];
    expect(await listNamespaces(reader(state, calls))).toHaveLength(121);
    expect(calls).toHaveLength(2);
  });

  test("a missing total_count is refused instead of ending after page one", async () => {
    const state = world("adopted");
    // The duplicate would sit on page two, which the old loop never read.
    state.namespaces.push({ id: "e".repeat(32), class: GATE, script: TARGET });
    state.namespacePage = (page, items) => ({
      result: items,
      result_info: { page, per_page: 100, count: items.length },
    });
    await expect(verify(state, "adopted")).rejects.toThrow(
      "namespace page 1 has missing or inconsistent pagination",
    );
  });

  test("a second admission namespace on a later page is found", async () => {
    for (const script of [API, TARGET]) {
      const state = world("adopted");
      state.namespaces.push({ id: "e".repeat(32), class: GATE, script });
      await expect(verify(state, "adopted")).rejects.toThrow(
        "A second production admission namespace exists",
      );
    }
  });

  test("a namespace repeated on a later page is inconsistent", async () => {
    const state = world("adopted");
    state.namespaces.splice(100, 1, state.namespaces[0]);
    await expect(listNamespaces(reader(state))).rejects.toThrow(
      "namespace page 2 repeats or omits a namespace ID",
    );
  });

  test("exhausting the page cap with namespaces left throws", async () => {
    const state = world("adopted");
    state.namespacePage = (page) => ({
      result: Array.from({ length: 100 }, (_, index) => ({
        id: `${page}-${index}`,
        class: "OtherClass",
      })),
      result_info: { page, per_page: 100, count: 100, total_count: 5_001 },
    });
    await expect(listNamespaces(reader(state))).rejects.toThrow(
      "did not finish within 50 pages",
    );
  });

  test("counts, totals, page numbers and short pages must agree", async () => {
    const info = (page: number, count: number, total: number) => ({
      page,
      per_page: 100,
      count,
      total_count: total,
    });
    const cases: [World["namespacePage"], string][] = [
      [
        (page, items) => ({ result: items, result_info: info(page, 99, 121) }),
        "namespace page 1 has missing or inconsistent pagination",
      ],
      [
        (page, items) => ({
          result: items,
          result_info: info(page, items.length, 120 + page),
        }),
        "namespace page 2 has missing or inconsistent pagination",
      ],
      [
        (page, items) => ({
          result: items,
          result_info: info(page, items.length, 300),
        }),
        "namespace pages do not add up to their total",
      ],
      [
        (_page, items) => ({
          result: items,
          result_info: info(1, items.length, 121),
        }),
        "namespace page 2 has missing or inconsistent pagination",
      ],
    ];
    for (const [namespacePage, message] of cases) {
      const state = world("adopted");
      state.namespacePage = namespacePage;
      await expect(listNamespaces(reader(state))).rejects.toThrow(message);
    }
  });
});

describe("each phase requires its owner, bindings and consumers", () => {
  const ownerOf = (phase: LivePhase) =>
    LIVE_PHASES[phase].owner === "api" ? API : TARGET;

  for (const phase of PHASES)
    test(`${phase} reads back with its expected owner`, async () => {
      const receipt = await verify(world(phase), phase);
      const live = LIVE_PHASES[phase];
      expect(receipt.owner).toBe(ownerOf(phase));
      expect(receipt.consumers).toEqual([
        { script: DIAG, binding: "PRODUCTION", version: "diag-v1" },
      ]);
      expect(receipt.namespaceBindings).toEqual(
        [
          `${API}/INFERENCE_ADMISSION_GATES`,
          `${DIAG}/PRODUCTION`,
          ...(live.target === "bound"
            ? [`${TARGET}/INFERENCE_ADMISSION_GATES`]
            : []),
        ].sort(),
      );
      expect(receipt.target === null).toBe(live.target === "absent");
      if (live.target !== "absent")
        expect(receipt.parityVariables).toEqual([
          "ENVIRONMENT",
          "INFERENCE_FUNDED_BUDGET_ADMISSION",
          "INFERENCE_RATE_POLICY_ADMISSION",
          "INFERENCE_STRONG_REVOCATION_ENABLED",
          "VOICE_SPEECH_RELAY_ENABLED",
        ]);
    });

  for (const phase of PHASES)
    test(`${phase} refuses the wrong namespace owner`, async () => {
      const state = world(phase);
      state.namespaces[0].script = ownerOf(phase) === API ? TARGET : API;
      await expect(verify(state, phase)).rejects.toThrow(
        `${phase} requires ${ownerOf(phase)} to own the namespace`,
      );
    });

  for (const phase of PHASES)
    test(`${phase} proves the diagnostic consumer still resolves the namespace through the API`, async () => {
      const wrongNamespace = world(phase);
      wrongNamespace.scripts[DIAG].bindings[0].namespace_id = "f".repeat(32);
      await expect(verify(wrongNamespace, phase)).rejects.toThrow(
        `${DIAG} PRODUCTION must resolve ${NPROD} through ${API}`,
      );
      const rebound = world(phase);
      rebound.scripts[DIAG].bindings[0].script_name = TARGET;
      await expect(verify(rebound, phase)).rejects.toThrow(DIAG);
      const deleted = world(phase);
      delete deleted.scripts[DIAG];
      await expect(
        verify(deleted, phase, { inventory: false }),
      ).rejects.toThrow("HTTP 404");
    });

  test("the API binding must name the phase's serving script", async () => {
    const state = world("source-commit");
    state.scripts[API].bindings[0] = gate();
    await expect(verify(state, "source-commit")).rejects.toThrow(
      `${API} INFERENCE_ADMISSION_GATES must resolve ${NPROD} through ${TARGET}`,
    );
  });

  test("an unbound target may not bind the namespace, and a bound one must", async () => {
    const early = world("target-pending");
    early.scripts[TARGET].bindings.push(gate());
    await expect(verify(early, "target-pending")).rejects.toThrow("forbids");
    const late = world("adopted");
    late.scripts[TARGET].bindings.shift();
    await expect(verify(late, "adopted")).rejects.toThrow(TARGET);
  });

  test("the target must exist exactly when the phase expects it", async () => {
    const created = world("source-owned");
    created.scripts[TARGET] = world("target-pending").scripts[TARGET];
    await expect(verify(created, "source-owned")).rejects.toThrow("not exist");
    const missing = world("source-owned");
    await expect(verify(missing, "target-pending")).rejects.toThrow(
      `target-pending requires ${TARGET} to exist`,
    );
  });

  test("the target recovers only through the API capability", async () => {
    const state = world("target-pending");
    state.scripts[TARGET].bindings = state.scripts[TARGET].bindings.filter(
      (binding) => binding.name !== "INFERENCE_RECOVERY_SERVICE",
    );
    await expect(verify(state, "target-pending")).rejects.toThrow(
      "InferenceRecoveryService",
    );
  });

  test("an untracked binding of the namespace stops the phase", async () => {
    for (const binding of [
      { name: "ROGUE", type: "durable_object_namespace", namespace_id: NPROD },
      {
        name: "ROGUE",
        type: "durable_object_namespace",
        class_name: GATE,
        script_name: API,
      },
    ]) {
      const state = world("source-commit");
      state.scripts.rogue = { version: "rogue-v1", bindings: [binding] };
      await expect(verify(state, "source-commit")).rejects.toThrow(
        /^Namespace bindings differ from source-commit: .*, rogue\/ROGUE$/,
      );
    }
  });

  test("API and target variables must match, including unset gate policy", async () => {
    const changed = world("target-pending");
    changed.scripts[TARGET].bindings[2] = text(
      "INFERENCE_STRONG_REVOCATION_ENABLED",
      "true",
    );
    await expect(verify(changed, "target-pending")).rejects.toThrow(
      "Live variable differs between API and target: INFERENCE_STRONG_REVOCATION_ENABLED",
    );
    const funded = world("adopted");
    funded.scripts[API].bindings.push(
      text("INFERENCE_FUNDED_BUDGET_ADMISSION", "true"),
    );
    await expect(verify(funded, "adopted")).rejects.toThrow(
      "INFERENCE_FUNDED_BUDGET_ADMISSION",
    );
  });

  test("each deployed Worker must serve its commit", async () => {
    const state = world("adopted");
    expect(
      (await verify(state, "adopted", { commits: { target: "b".repeat(40) } }))
        .target?.commit,
    ).toBe("b".repeat(40));
    await expect(
      verify(state, "adopted", { commits: { api: "b".repeat(40) } }),
    ).rejects.toThrow(`${API} does not serve commit`);
  });

  test("release readback checks the steady state without an account scan", async () => {
    const calls: string[] = [];
    await verifyProductionAdmission(reader(world("adopted"), calls), {
      api: API,
      target: TARGET,
      phase: "adopted",
      commits: { target: "b".repeat(40) },
    });
    expect(calls.some((path) => path.endsWith("/settings"))).toBe(false);
    expect(calls).toContain(`/workers/scripts/${DIAG}/deployments`);
  });
});

describe("object sample readback", () => {
  const sampleOf = (state: World, indexes: number[]) =>
    new Map(
      indexes.map((index) => [
        state.objects[index].id,
        state.objects[index].hasStoredData,
      ]),
    );

  test("finds the saved IDs wherever enumeration lists them", async () => {
    const state = world("adopted");
    const sample = sampleOf(state, [20, 21, 27, 29]);
    // New objects created since the sample shift the enumeration order.
    state.objects.unshift(
      ...Array.from({ length: 9 }, (_, index) => ({
        id: hex(1_000 + index, 64),
        hasStoredData: true,
      })),
    );
    expect(await verifyObjectSample(reader(state), sample)).toEqual({
      sampled: 4,
      storedDataBefore: 2,
      gainedStoredData: 0,
      listed: 39,
      pages: 6,
    });
  });

  test("a missing sampled object stops the phase", async () => {
    const state = world("adopted");
    const sample = sampleOf(state, [1, 2]);
    sample.set(hex(9_999, 64), true);
    await expect(verifyObjectSample(reader(state), sample)).rejects.toThrow(
      "1 sampled objects are missing from the namespace",
    );
  });

  test("lost stored data stops the phase; gained stored data is counted", async () => {
    const state = world("adopted");
    const lost = sampleOf(state, [1]);
    state.objects[1].hasStoredData = false;
    await expect(verifyObjectSample(reader(state), lost)).rejects.toThrow(
      "A sampled object lost its stored data",
    );
    const gained = sampleOf(state, [0, 1]);
    state.objects[0].hasStoredData = true;
    expect(
      (await verifyObjectSample(reader(state), gained)).gainedStoredData,
    ).toBe(1);
  });

  test("repeated objects, repeated cursors and the page cap fail closed", async () => {
    const repeated = world("adopted");
    repeated.objects.splice(10, 0, repeated.objects[2]);
    await expect(
      verifyObjectSample(reader(repeated), sampleOf(repeated, [29])),
    ).rejects.toThrow("repeats or malforms an object");

    const stuck = world("adopted");
    let page = 0;
    const read: CloudflareRead = async () => {
      page += 1;
      return {
        result: [stuck.objects[page]],
        result_info: { count: 1, cursor: "same" },
      };
    };
    await expect(
      verifyObjectSample(read, sampleOf(stuck, [29])),
    ).rejects.toThrow("Cloudflare object cursor repeated");

    const long = world("adopted");
    long.objects = Array.from({ length: 150 }, (_, index) => ({
      id: hex(index, 64),
      hasStoredData: true,
    }));
    long.objectPageSize = 1;
    await expect(
      verifyObjectSample(reader(long), sampleOf(long, [140])),
    ).rejects.toThrow("within 100 pages");
  });

  test("the saved sample must be well formed and match its summary", () => {
    const objects = [
      { id: "a".repeat(64), hasStoredData: true },
      { id: "b".repeat(64), hasStoredData: false },
    ];
    const summary = (observedObjects: number, storedDataObjects: number) =>
      JSON.stringify({ namespace: NPROD, observedObjects, storedDataObjects });
    expect(
      parseObjectSample(
        JSON.stringify({ namespace: NPROD, objects }),
        summary(2, 1),
      ),
    ).toEqual(
      new Map([
        ["a".repeat(64), true],
        ["b".repeat(64), false],
      ]),
    );
    expect(parseObjectSample(JSON.stringify(objects)).size).toBe(2);
    expect(() =>
      parseObjectSample(JSON.stringify({ objects }), summary(2, 2)),
    ).toThrow("does not match its saved summary");
    expect(() =>
      parseObjectSample(JSON.stringify({ namespace: "f".repeat(32), objects })),
    ).toThrow("objects of the namespace");
    expect(() =>
      parseObjectSample(JSON.stringify([...objects, objects[0]])),
    ).toThrow("malformed or repeated");
    expect(() =>
      parseObjectSample(JSON.stringify([{ id: "short", hasStoredData: true }])),
    ).toThrow("malformed or repeated");
  });
});

describe("phase continuity", () => {
  const receipt = (
    phase: LivePhase,
    api = "api-v1",
    target: string | null = "target-v1",
    diag = "diag-v1",
  ): Receipt => ({
    phase,
    namespace: NPROD,
    owner: LIVE_PHASES[phase].owner === "api" ? API : TARGET,
    api: { script: API, version: api },
    target: target === null ? null : { script: TARGET, version: target },
    consumers: [{ script: DIAG, binding: "PRODUCTION", version: diag }],
  });

  test("the forward and reverse chains change only the deployed Worker", () => {
    const chain = [
      receipt("source-owned", "api-v1", null),
      receipt("target-pending", "api-v1", "target-v1"),
      receipt("source-commit", "api-v2", "target-v1"),
      receipt("adopted", "api-v2", "target-v2"),
      receipt("reverse-pending", "api-v3", "target-v2"),
      receipt("reverse-commit", "api-v3", "target-v3"),
      receipt("reverse-adopted", "api-v4", "target-v3"),
    ];
    for (let index = 1; index < chain.length; index += 1) {
      requirePhaseContinuity(chain[index - 1], chain[index]);
      requirePhaseContinuity(chain[index], chain[index]);
    }
  });

  test("an untracked deploy, consumer change or skipped phase stops the chain", () => {
    expect(() =>
      requirePhaseContinuity(
        receipt("source-owned", "api-v1", null),
        receipt("target-pending", "api-v2"),
      ),
    ).toThrow("The API version changed outside its phase");
    expect(() =>
      requirePhaseContinuity(
        receipt("target-pending"),
        receipt("source-commit", "api-v2", "target-v2"),
      ),
    ).toThrow("The target version changed outside its phase");
    expect(() =>
      requirePhaseContinuity(
        receipt("target-pending"),
        receipt("source-commit", "api-v2", "target-v1", "diag-v2"),
      ),
    ).toThrow(`${DIAG} changed during the transfer`);
    expect(() =>
      requirePhaseContinuity(receipt("target-pending"), receipt("adopted")),
    ).toThrow("adopted cannot follow target-pending");
    expect(() =>
      requirePhaseContinuity(receipt("adopted"), receipt("source-commit")),
    ).toThrow("source-commit cannot follow adopted");
    expect(() =>
      requirePhaseContinuity(receipt("adopted"), receipt("adopted", "api-v2")),
    ).toThrow("The API version changed outside its phase");
  });
});
