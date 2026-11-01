/** Fixtures for the production admission readback; no Cloudflare calls. */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type CloudflareRead,
  effectiveVariables,
  KNOWN_EXTERNAL_CONSUMERS,
  LIVE_PHASES,
  type LivePhase,
  listNamespaces,
  listScripts,
  PRODUCTION_ADMISSION_NAMESPACE_ID as NPROD,
  parseObjectSample,
  type Receipt,
  type ReleasePhase,
  readbackRequest,
  releaseCheck,
  requirePhaseContinuity,
  verifyAnyPhase,
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
  scripts: Record<
    string,
    { version: string; bindings: Binding[]; classes?: string[] | null }
  >;
  scriptList?: () => Awaited<ReturnType<CloudflareRead>>;
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
const setText = (bindings: Binding[], name: string, value: string) => {
  bindings[bindings.findIndex((binding) => binding.name === name)] = text(
    name,
    value,
  );
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hex = (value: number, length: number) =>
  value.toString(16).padStart(length, "0");

function world(phase: LivePhase): World {
  const live = LIVE_PHASES[phase];
  const scripts: World["scripts"] = {
    [API]: {
      version: "api-v1",
      classes: [GATE, "SpeechRelayCoordinator"],
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
      classes: [GATE],
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
      return (
        state.scriptList?.() ?? {
          result: Object.keys(state.scripts).map((id) => ({ id })),
        }
      );
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
          ? {
              id: worker.version,
              resources: {
                bindings: worker.bindings,
                script:
                  worker.classes === null
                    ? {}
                    : {
                        named_handlers: (worker.classes ?? []).map((name) => ({
                          name,
                          handlers: ["class"],
                        })),
                      },
              },
            }
          : undefined,
    };
  };
}

// Root's receipts as the readback parses them: the API's live values and the
// version they read.
const EFFECTIVE = {
  variables: new Map([
    ["ELIZA_DEPLOY_COMMIT", "f".repeat(40)],
    ["ENVIRONMENT", "production"],
    ["INFERENCE_STRONG_REVOCATION_ENABLED", "false"],
    ["VOICE_SPEECH_RELAY_ENABLED", "true"],
  ]),
  version: "api-v1",
};

const verify = (
  state: World,
  phase: LivePhase,
  extra: Partial<Parameters<typeof verifyProductionAdmission>[1]> = {},
) =>
  verifyProductionAdmission(reader(state), {
    api: API,
    target: TARGET,
    phase,
    effective: EFFECTIVE,
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
          "ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES",
          "ELIZA_CLOUD_PLAN_RATE_LIMITS",
          "ENVIRONMENT",
          "INFERENCE_FUNDED_BUDGET_ADMISSION",
          "INFERENCE_RATE_POLICY_ADMISSION",
          "INFERENCE_STRONG_REVOCATION_ENABLED",
          "VOICE_SPEECH_RELAY_ENABLED",
        ]);
      expect(Object.keys(receipt.apiVariables ?? {})).toEqual([
        "ENVIRONMENT",
        "INFERENCE_STRONG_REVOCATION_ENABLED",
        "VOICE_SPEECH_RELAY_ENABLED",
      ]);
      expect(receipt.apiVariables?.ENVIRONMENT).toBe(digest("production"));
      expect(receipt.targetVariables === undefined).toBe(
        live.target === "absent",
      );
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
    test(`${phase} keeps the diagnostic consumer's binding record on the API`, async () => {
      const wrongNamespace = world(phase);
      wrongNamespace.scripts[DIAG].bindings[0].namespace_id = "f".repeat(32);
      await expect(verify(wrongNamespace, phase)).rejects.toThrow(
        `${DIAG} PRODUCTION must name ${NPROD} through ${API}`,
      );
      const rebound = world(phase);
      rebound.scripts[DIAG].bindings[0].script_name = TARGET;
      await expect(verify(rebound, phase)).rejects.toThrow(DIAG);
      const deleted = world(phase);
      delete deleted.scripts[DIAG];
      await expect(
        verify(deleted, phase, { effective: undefined }),
      ).rejects.toThrow(`The script list does not include ${DIAG}`);
    });

  test("the API binding must name the phase's serving script", async () => {
    const state = world("source-commit");
    state.scripts[API].bindings[0] = gate();
    await expect(verify(state, "source-commit")).rejects.toThrow(
      `${API} INFERENCE_ADMISSION_GATES must name ${NPROD} through ${TARGET}`,
    );
  });

  for (const phase of PHASES)
    test(`${phase} requires the class code exported by the API and the target`, async () => {
      const api = world(phase);
      api.scripts[API].classes = ["SpeechRelayCoordinator"];
      await expect(verify(api, phase)).rejects.toThrow(
        `${API} version api-v1 does not export InferenceAdmissionGate`,
      );
      const unread = world(phase);
      unread.scripts[API].classes = null;
      await expect(verify(unread, phase)).rejects.toThrow("does not export");
      if (LIVE_PHASES[phase].target === "absent") return;
      const target = world(phase);
      target.scripts[TARGET].classes = [];
      await expect(verify(target, phase)).rejects.toThrow(
        `${TARGET} version target-v1 does not export InferenceAdmissionGate`,
      );
    });

  test("the script list must be one complete, unique page", async () => {
    const ids = (state: World) =>
      Object.keys(state.scripts).map((id) => ({ id }));
    const cases: ((state: World) => Awaited<ReturnType<CloudflareRead>>)[] = [
      (state) => ({ result: [...ids(state), ids(state)[0]] }),
      (state) => ({
        result: ids(state),
        result_info: { total_count: ids(state).length + 1 },
      }),
      (state) => ({ result: ids(state), result_info: { cursor: "next" } }),
      (state) => ({ result: ids(state), result_info: { total_pages: 2 } }),
      (state) => ({ result: ids(state), result_info: { page: 2 } }),
      (state) => ({
        result: ids(state),
        result_info: { count: ids(state).length - 1 },
      }),
    ];
    for (const scriptList of cases) {
      const state = world("adopted");
      state.scriptList = () => scriptList(state);
      await expect(verify(state, "adopted")).rejects.toThrow(
        "Cloudflare script list is incomplete or paginated",
      );
    }
    const complete = world("adopted");
    complete.scriptList = () => ({
      result: ids(complete),
      result_info: {
        page: 1,
        total_pages: 1,
        count: ids(complete).length,
        total_count: ids(complete).length,
        cursor: "",
      },
    });
    expect(await listScripts(reader(complete))).toHaveLength(4);
    const malformed = world("adopted");
    malformed.scriptList = () => ({ result: [{ name: API }] });
    await expect(listScripts(reader(malformed))).rejects.toThrow(
      "did not return the script list",
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

  test("the live API keeps Root's effective variables", async () => {
    const changed = world("source-commit");
    for (const script of [API, TARGET])
      setText(
        changed.scripts[script].bindings,
        "VOICE_SPEECH_RELAY_ENABLED",
        "false",
      );
    await expect(verify(changed, "source-commit")).rejects.toThrow(
      "Live API VOICE_SPEECH_RELAY_ENABLED differs from Root's receipts",
    );
    // Equal on both Workers still differs from production's unset policy.
    for (const name of [
      "INFERENCE_RATE_POLICY_ADMISSION",
      "ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES",
      "ELIZA_CLOUD_PLAN_RATE_LIMITS",
    ]) {
      const set = world("adopted");
      set.scripts[API].bindings.push(text(name, "{}"));
      set.scripts[TARGET].bindings.push(text(name, "{}"));
      await expect(verify(set, "adopted")).rejects.toThrow(
        `Live API sets ${name}, which Root's receipts leave unset`,
      );
    }
    const allowed = world("adopted");
    allowed.scripts[API].bindings.push(
      text("ELIZA_CLOUD_PLAN_RATE_LIMITS", "{}"),
    );
    allowed.scripts[TARGET].bindings.push(
      text("ELIZA_CLOUD_PLAN_RATE_LIMITS", "{}"),
    );
    const variables = new Map(EFFECTIVE.variables).set(
      "ELIZA_CLOUD_PLAN_RATE_LIMITS",
      "{}",
    );
    expect(
      (
        await verify(allowed, "adopted", {
          effective: { ...EFFECTIVE, variables },
        })
      ).apiVariables?.ELIZA_CLOUD_PLAN_RATE_LIMITS,
    ).toBe(digest("{}"));
  });

  test("Root's receipts must have read the API version until the API deploys", async () => {
    for (const phase of ["source-owned", "target-pending"] as LivePhase[]) {
      await expect(
        verify(world(phase), phase, {
          effective: { ...EFFECTIVE, version: "api-v0" },
        }),
      ).rejects.toThrow(
        "Effective variable receipts read api-v0, not the live API version api-v1",
      );
      await expect(
        verify(world(phase), phase, {
          effective: { ...EFFECTIVE, version: undefined },
        }),
      ).rejects.toThrow("receipts read undefined");
    }
    // After phase 2 the API version is new; the values still must match.
    expect(
      (
        await verify(world("source-commit"), "source-commit", {
          effective: { ...EFFECTIVE, version: "api-v0" },
        })
      ).owner,
    ).toBe(TARGET);
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
    // The Maps allowance controller reads these from the gate's environment.
    const maps = world("adopted");
    maps.scripts[TARGET].bindings.push(
      text("ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES", "{}"),
    );
    await expect(verify(maps, "adopted")).rejects.toThrow(
      "Live variable differs between API and target: ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES",
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

describe("release readback of the committed phase", () => {
  const before = (committed: ReleasePhase, live: LivePhase) =>
    verifyAnyPhase(releaseCheck("before", committed).phases, (phase) =>
      verifyProductionAdmission(reader(world(live)), {
        api: API,
        target: TARGET,
        phase,
      }),
    );

  test("an upload starts from the committed phase or its reverse predecessor", async () => {
    expect((await before("adopted", "adopted")).phase).toBe("adopted");
    expect((await before("reverse-pending", "adopted")).phase).toBe("adopted");
    expect((await before("reverse-adopted", "reverse-commit")).phase).toBe(
      "reverse-commit",
    );
    expect((await before("reverse-adopted", "reverse-adopted")).phase).toBe(
      "reverse-adopted",
    );
    await expect(before("adopted", "source-commit")).rejects.toThrow(
      `The live state is not adopted: ${TARGET} binding must name`,
    );
    await expect(before("reverse-pending", "reverse-commit")).rejects.toThrow(
      "The live state is not adopted or reverse-pending",
    );
    await expect(before("reverse-adopted", "adopted")).rejects.toThrow(
      "The live state is not reverse-commit or reverse-adopted",
    );
  });

  test("after an upload every uploaded Worker serves the release commit", () => {
    const sha = "c".repeat(40);
    expect(releaseCheck("admission", "adopted", sha)).toEqual({
      phases: ["adopted"],
      commits: { target: sha },
    });
    expect(releaseCheck("api", "adopted", sha).commits).toEqual({
      target: sha,
      api: sha,
    });
    for (const phase of ["reverse-pending", "reverse-adopted"] as const) {
      expect(releaseCheck("api", phase, sha)).toEqual({
        phases: [phase],
        commits: { api: sha },
      });
      expect(() => releaseCheck("admission", phase, sha)).toThrow(
        `A ${phase} release does not upload the admission Worker`,
      );
    }
  });

  test("the command line separates release checks from Root's phase proof", () => {
    const sha = "d".repeat(40);
    const proof = {
      "object-sample": "sample.json",
      "object-summary": "summary.json",
      effective: ["flags.json"],
    };
    expect(readbackRequest({ stage: "before" })).toEqual({
      release: true,
      phases: ["adopted"],
      commits: {},
    });
    expect(
      readbackRequest({ stage: "api", phase: "reverse-adopted", commit: sha }),
    ).toEqual({
      release: true,
      phases: ["reverse-adopted"],
      commits: { api: sha },
    });
    expect(
      readbackRequest({ phase: "target-pending", commit: sha, ...proof }),
    ).toEqual({
      release: false,
      phases: ["target-pending"],
      commits: { target: sha },
    });
    // R0 may pin the commit the API serves before any deploy.
    expect(
      readbackRequest({ phase: "source-owned", ...proof }).commits,
    ).toEqual({});
    expect(
      readbackRequest({ phase: "source-owned", commit: sha, ...proof }).commits,
    ).toEqual({ api: sha });
    const refused: [Parameters<typeof readbackRequest>[0], string][] = [
      [{ stage: "before", commit: sha }, "omit --commit"],
      [{ stage: "api" }, "--commit must be the released"],
      [{ stage: "before", phase: "source-commit" }, "A release publishes only"],
      [
        { stage: "admission", phase: "reverse-pending", commit: sha },
        "does not upload the admission Worker",
      ],
      [{ stage: "during" }, "--stage must be before, admission or api"],
      [{ stage: "before", previous: "R1.json" }, "Root's phase proof"],
      [{ stage: "before", effective: ["flags.json"] }, "Root's phase proof"],
      [{ phase: "source-commit", ...proof }, "--commit must be the deployed"],
      [
        { phase: "adopted", commit: sha, "object-sample": "sample.json" },
        "--phase requires --object-sample, --object-summary and --effective",
      ],
      [
        { phase: "adopted", commit: sha, ...proof, effective: [] },
        "--phase requires",
      ],
      [{ phase: "bogus" }, "Pass --stage (release) or --phase"],
      [{}, "Pass --stage (release) or --phase"],
      [{ phase: "adopted", commit: "abc" }, "40-character SHA"],
    ];
    for (const [values, message] of refused)
      expect(() => readbackRequest(values)).toThrow(message);
  });
});

describe("Root's effective-variable receipts", () => {
  test("receipt shapes merge, agree and name the version they read", () => {
    const current = JSON.stringify({
      version: "742e1bf0-5c05-41c1-9b1b-b957be25800b",
      flags: [
        { name: "ENVIRONMENT", type: "plain_text", text: "production" },
        {
          name: "INFERENCE_STRONG_REVOCATION_ENABLED",
          type: "plain_text",
          text: "false",
        },
      ],
    });
    const review = JSON.stringify({
      effectiveFlags: {
        [API]: { INFERENCE_STRONG_REVOCATION_ENABLED: "false" },
        "eliza-cloud-api-staging": {
          INFERENCE_STRONG_REVOCATION_ENABLED: "true",
        },
      },
    });
    const fundedRate = JSON.stringify({
      flags: { [API]: {}, "eliza-cloud-api-staging": {} },
    });
    expect(effectiveVariables([current, review, fundedRate])).toEqual({
      variables: new Map([
        ["ENVIRONMENT", "production"],
        ["INFERENCE_STRONG_REVOCATION_ENABLED", "false"],
      ]),
      version: "742e1bf0-5c05-41c1-9b1b-b957be25800b",
    });
    expect(effectiveVariables([review]).version).toBeUndefined();
    const conflicting = JSON.stringify({
      effectiveFlags: {
        [API]: { INFERENCE_STRONG_REVOCATION_ENABLED: "true" },
      },
    });
    expect(() => effectiveVariables([current, conflicting])).toThrow(
      "disagree on INFERENCE_STRONG_REVOCATION_ENABLED",
    );
    expect(() =>
      effectiveVariables([
        current,
        JSON.stringify({ version: "other", flags: [] }),
      ]),
    ).toThrow("read different versions");
    expect(() =>
      effectiveVariables([
        JSON.stringify({ flags: [{ name: "SECRET", type: "secret_text" }] }),
      ]),
    ).toThrow("is not plain text");
    expect(() => effectiveVariables([JSON.stringify({ other: {} })])).toThrow(
      "Unrecognized effective-variable receipt",
    );
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
    // Root saved IDs from the end of enumeration, not the first ones listed.
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
      lostStoredData: 0,
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

  test("traffic may add or delete stored data; a wipe of most of the sample stops", async () => {
    const state = world("adopted");
    // Indexes 1, 2, 4 and 5 have stored data; 0 and 3 do not.
    const sample = sampleOf(state, [0, 1, 2, 3, 4, 5]);
    state.objects[0].hasStoredData = true;
    state.objects[1].hasStoredData = false;
    state.objects[2].hasStoredData = false;
    expect(await verifyObjectSample(reader(state), sample)).toMatchObject({
      storedDataBefore: 4,
      gainedStoredData: 1,
      lostStoredData: 2,
    });
    state.objects[4].hasStoredData = false;
    await expect(verifyObjectSample(reader(state), sample)).rejects.toThrow(
      "3 of 4 sampled objects lost their stored data",
    );
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

  const objects = [
    { id: "b".repeat(64), hasStoredData: false },
    { id: "a".repeat(64), hasStoredData: true },
  ];
  const identity = digest(`${"a".repeat(64)}\n${"b".repeat(64)}`);
  const summary = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      namespace: NPROD,
      observedObjects: 2,
      storedDataObjects: 1,
      identitySetSHA256: identity,
      ...overrides,
    });

  test("the saved sample is Root's: counts and the sorted-ID hash match its summary", () => {
    expect(
      parseObjectSample(
        JSON.stringify({ namespace: NPROD, objects }),
        summary(),
      ),
    ).toEqual({
      sample: new Map([
        ["b".repeat(64), false],
        ["a".repeat(64), true],
      ]),
      identitySetSHA256: identity,
    });
    expect(
      parseObjectSample(JSON.stringify(objects), summary()).identitySetSHA256,
    ).toBe(identity);
    // Another sample with the same counts is not Root's sample.
    const other = [objects[0], { id: "c".repeat(64), hasStoredData: true }];
    expect(() => parseObjectSample(JSON.stringify(other), summary())).toThrow(
      "Object sample IDs do not match the summary's identitySetSHA256",
    );
    for (const changed of [
      { storedDataObjects: 2 },
      { observedObjects: 3 },
      { namespace: "f".repeat(32) },
    ])
      expect(() =>
        parseObjectSample(JSON.stringify(objects), summary(changed)),
      ).toThrow("does not match its saved summary counts");
    expect(() =>
      parseObjectSample(
        JSON.stringify(objects),
        summary({ identitySetSHA256: undefined }),
      ),
    ).toThrow("identitySetSHA256");
  });

  test("the saved sample must be well formed", () => {
    expect(() =>
      parseObjectSample(
        JSON.stringify({ namespace: "f".repeat(32), objects }),
        summary(),
      ),
    ).toThrow("objects of the namespace");
    expect(() =>
      parseObjectSample(JSON.stringify([...objects, objects[0]]), summary()),
    ).toThrow("malformed or repeated");
    expect(() =>
      parseObjectSample(
        JSON.stringify([{ id: "short", hasStoredData: true }]),
        summary(),
      ),
    ).toThrow("malformed or repeated");
    expect(() => parseObjectSample("[]", summary())).toThrow(
      "objects of the namespace",
    );
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
    apiVariables: { ENVIRONMENT: digest("production") },
    ...(target === null
      ? {}
      : { targetVariables: { ENVIRONMENT: digest("production") } }),
    objectSample: { fileSHA256: "sample", identitySetSHA256: "identity" },
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

  test("the saved sample and every variable stay the same across phases", () => {
    const previous = receipt("target-pending");
    const next = () => receipt("source-commit", "api-v2");
    const file = next();
    file.objectSample = { ...file.objectSample, fileSHA256: "other" };
    const identity = next();
    identity.objectSample = {
      ...identity.objectSample,
      identitySetSHA256: "x",
    };
    for (const changed of [file, identity])
      expect(() => requirePhaseContinuity(previous, changed)).toThrow(
        "The object sample changed during the transfer",
      );
    // Phase 2's protected release republishes every API variable unchanged.
    const api = next();
    api.apiVariables = {
      ENVIRONMENT: digest("production"),
      KOKORO_TTS_URL: digest("https://example.invalid"),
    };
    expect(() => requirePhaseContinuity(previous, api)).toThrow(
      "API variables changed: KOKORO_TTS_URL",
    );
    const target = receipt("adopted", "api-v2", "target-v2");
    target.targetVariables = { ENVIRONMENT: digest("staging") };
    expect(() =>
      requirePhaseContinuity(receipt("source-commit", "api-v2"), target),
    ).toThrow("Target variables changed: ENVIRONMENT");
    const release = next();
    delete release.objectSample;
    expect(() => requirePhaseContinuity(previous, release)).toThrow(
      "Continuity compares two phase receipts",
    );
  });
});
