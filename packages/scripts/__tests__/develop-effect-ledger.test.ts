/** Exercises exact-SHA effect planning, durable ledger verification, partial reconciliation, and fast-forward policy deterministically. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicallyPromoteRefs,
  buildEffectPlans,
  createLedgerPayload,
  decideEffectReconciliation,
  decidePromotion,
  dispatchEffect,
  listEffectDeployments,
  reconcileEffect,
  selectRediscoveredRun,
  sha256,
  simulateReconciliation,
  validateRegistry,
  validateSourceRun,
  verifyLedgerPayload,
} from "../develop-effect-ledger.mjs";
import { createEvidence } from "../develop-impact-evidence.mjs";

const SOURCE_SHA = "a".repeat(40);
const PRIOR_SHA = "b".repeat(40);
const MAIN_SHA = "c".repeat(40);
const NOW = new Date();

function registry() {
  return {
    schemaVersion: 1,
    ledgerVersion: "fixture-v1",
    effects: [
      {
        id: "cloud-staging",
        workflow: "effect.yml",
        surfaces: ["cloud", "canonical"],
        shaInput: "source_sha",
        inputs: { environment: "staging" },
      },
    ],
    promotion: {
      id: "main-promotion",
      sourceBranch: "develop",
      targetBranch: "main",
    },
  };
}

function manifests() {
  const expected = {
    schemaVersion: 1,
    environmentDigest: sha256("environment"),
    evidenceTtlHours: 24,
    graphDigest: sha256("graph"),
    headSha: SOURCE_SHA,
    surfaces: [
      { id: "canonical", inputDigest: sha256("canonical") },
      { id: "cloud", inputDigest: sha256("cloud") },
    ],
  };
  return {
    expected,
    observed: {
      schemaVersion: 1,
      environmentDigest: expected.environmentDigest,
      graphDigest: expected.graphDigest,
      headSha: SOURCE_SHA,
      surfaces: expected.surfaces.map((surface) =>
        createEvidence(expected, surface.id, NOW, 24),
      ),
    },
  };
}

function fixtureRoot(workflow = "effect-v1") {
  const root = mkdtempSync(path.join(tmpdir(), "develop-effect-ledger-"));
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(root, ".github/workflows/effect.yml"), workflow);
  return root;
}

function plans(
  options: { workflow?: string; registry?: ReturnType<typeof registry> } = {},
) {
  const { expected, observed } = manifests();
  return buildEffectPlans({
    expected,
    observed,
    registry: options.registry ?? registry(),
    repoRoot: fixtureRoot(options.workflow),
  });
}

function payload(
  plan: ReturnType<typeof plans>["plans"][number],
  sourceSha = SOURCE_SHA,
) {
  return createLedgerPayload({
    effect: plan.id,
    inputDigest: plan.inputDigest,
    ledgerVersion: "fixture-v1",
    sourceRunId: "42",
    sourceSha,
    workflow: plan.workflow,
  });
}

function deployment(
  plan: ReturnType<typeof plans>["plans"][number],
  options: {
    id?: number;
    sourceSha?: string;
    state?: string;
    inputDigest?: string;
  } = {},
) {
  const row = payload(
    { ...plan, inputDigest: options.inputDigest ?? plan.inputDigest },
    options.sourceSha ?? SOURCE_SHA,
  );
  return {
    id: options.id ?? 1,
    payload: row,
    state: options.state ?? "success",
    status: null,
  };
}

describe("develop effect registry and exact plans", () => {
  test("binds surface digests, effect workflow bytes, inputs, and registry", () => {
    const baseline = plans();
    const repeated = plans();
    expect(baseline.plans[0].inputDigest).toBe(repeated.plans[0].inputDigest);
    expect(plans({ workflow: "effect-v2" }).plans[0].inputDigest).not.toBe(
      baseline.plans[0].inputDigest,
    );
    const changedRegistry = registry();
    changedRegistry.effects[0].inputs.environment = "production";
    expect(plans({ registry: changedRegistry }).plans[0].inputDigest).not.toBe(
      baseline.plans[0].inputDigest,
    );
    const changed = manifests();
    changed.expected.surfaces[0].inputDigest = sha256("changed-surface");
    changed.observed.surfaces = changed.expected.surfaces.map((surface) =>
      createEvidence(changed.expected, surface.id, NOW, 24),
    );
    expect(
      buildEffectPlans({
        expected: changed.expected,
        observed: changed.observed,
        registry: registry(),
        repoRoot: fixtureRoot(),
      }).plans[0].inputDigest,
    ).not.toBe(baseline.plans[0].inputDigest);
  });

  test("rejects duplicate, empty, colliding, and smuggled definitions", () => {
    const duplicate = registry();
    duplicate.effects.push({ ...duplicate.effects[0] });
    expect(() => validateRegistry(duplicate)).toThrow("duplicate effect id");
    const empty = registry();
    empty.effects = [];
    expect(() => validateRegistry(empty)).toThrow("must contain effects");
    const collision = registry();
    collision.promotion.id = collision.effects[0].id;
    expect(() => validateRegistry(collision)).toThrow("collides");
    const smuggled = registry();
    smuggled.effects[0].inputs.source_sha = SOURCE_SHA;
    expect(() => validateRegistry(smuggled)).toThrow("override shaInput");
  });

  test("fails closed for unknown surfaces and stale or tampered manifests", () => {
    const unknown = registry();
    unknown.effects[0].surfaces.push("missing");
    expect(() => plans({ registry: unknown })).toThrow("unknown surface");
    const root = fixtureRoot();
    const { expected, observed } = manifests();
    observed.surfaces[0].inputDigest = sha256("tampered");
    expect(() =>
      buildEffectPlans({
        expected,
        observed,
        registry: registry(),
        repoRoot: root,
      }),
    ).toThrow("input digest mismatch");
  });
});

describe("source and durable ledger contracts", () => {
  const greenRun = {
    id: 42,
    event: "push",
    head_branch: "develop",
    head_sha: SOURCE_SHA,
    path: ".github/workflows/develop-full.yml",
    status: "completed",
    conclusion: "success",
  };

  test("accepts only the exact green Develop Full push", () => {
    expect(validateSourceRun(greenRun, SOURCE_SHA, "42")).toBe(greenRun);
    for (const mutation of [
      { event: "pull_request" },
      { head_branch: "main" },
      { head_sha: PRIOR_SHA },
      { path: ".github/workflows/ci.yml" },
      { conclusion: "failure" },
    ]) {
      expect(() =>
        validateSourceRun({ ...greenRun, ...mutation }, SOURCE_SHA, "42"),
      ).toThrow();
    }
  });

  test("cryptographically rejects stale, extended, and tampered payloads", () => {
    const plan = plans().plans[0];
    const row = payload(plan);
    expect(verifyLedgerPayload(row)).toEqual(row);
    expect(() =>
      verifyLedgerPayload({ ...row, inputDigest: sha256("tampered") }),
    ).toThrow("digest mismatch");
    expect(() => verifyLedgerPayload({ ...row, extra: true })).toThrow(
      "ambiguous",
    );
    expect(() => verifyLedgerPayload({ ...row, schemaVersion: 0 })).toThrow(
      "stale",
    );
  });

  test("resumes partial work and reuses only exact successful input proof", () => {
    const plan = plans().plans[0];
    expect(decideEffectReconciliation(plan, SOURCE_SHA, []).action).toBe(
      "dispatch",
    );
    expect(
      decideEffectReconciliation(plan, SOURCE_SHA, [
        deployment(plan, { state: "in_progress" }),
      ]).action,
    ).toBe("resume");
    expect(
      decideEffectReconciliation(plan, SOURCE_SHA, [deployment(plan)]).action,
    ).toBe("reuse-exact");
    expect(
      decideEffectReconciliation(plan, SOURCE_SHA, [
        deployment(plan, { sourceSha: PRIOR_SHA }),
      ]).action,
    ).toBe("reuse-input");
    expect(() =>
      decideEffectReconciliation(plan, SOURCE_SHA, [
        deployment(plan),
        deployment(plan, { id: 2 }),
      ]),
    ).toThrow("duplicate exact ledger");
    expect(() =>
      decideEffectReconciliation(plan, SOURCE_SHA, [
        deployment(plan, { inputDigest: sha256("conflict") }),
      ]),
    ).toThrow("conflicting input digest");
  });

  test("paginates beyond 100 ledger rows without silently dropping proof", async () => {
    const plan = plans().plans[0];
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      payload: payload(plan, index === 100 ? SOURCE_SHA : PRIOR_SHA),
    }));
    const api = {
      request: async (_method: string, endpoint: string) => {
        if (endpoint.startsWith("/deployments?")) {
          const page = Number(
            new URL(`https://example.test${endpoint}`).searchParams.get("page"),
          );
          return page === 1 ? rows.slice(0, 100) : rows.slice(100);
        }
        return [
          { state: "success", log_url: "https://example.test/actions/runs/1" },
        ];
      },
    };
    expect(await listEffectDeployments(api, plan)).toHaveLength(101);
  });

  test("rediscovery binds a crashed dispatch to exact workflow, SHA, and digest", () => {
    const plan = plans().plans[0];
    const matching = {
      id: 99,
      display_title: `Cloud ${SOURCE_SHA} ${plan.inputDigest}`,
      event: "workflow_dispatch",
      head_sha: SOURCE_SHA,
      path: `.github/workflows/${plan.workflow}`,
    };
    expect(selectRediscoveredRun(plan, SOURCE_SHA, [matching])).toBe(matching);
    expect(
      selectRediscoveredRun(plan, SOURCE_SHA, [
        { ...matching, id: 1, head_sha: PRIOR_SHA },
      ]),
    ).toBeNull();
    expect(() =>
      selectRediscoveredRun(plan, SOURCE_SHA, [
        matching,
        { ...matching, id: 100 },
      ]),
    ).toThrow("multiple downstream runs");
  });

  test("resumes a crash after dispatch without redelivering the effect", async () => {
    const plan = plans().plans[0];
    const row = payload(plan);
    const calls: Array<{ method: string; endpoint: string; body?: unknown }> =
      [];
    const run = {
      id: 99,
      conclusion: "success",
      display_title: `Cloud ${SOURCE_SHA} ${plan.inputDigest}`,
      event: "workflow_dispatch",
      head_sha: SOURCE_SHA,
      path: `.github/workflows/${plan.workflow}`,
      status: "completed",
    };
    const api = {
      request: async (method: string, endpoint: string, body?: unknown) => {
        calls.push({ method, endpoint, body });
        if (endpoint.startsWith("/deployments?")) {
          return endpoint.includes("page=1") ? [{ id: 7, payload: row }] : [];
        }
        if (endpoint === "/deployments/7/statuses?per_page=1") return [];
        if (endpoint.includes(`/actions/workflows/${plan.workflow}/runs?`)) {
          return { workflow_runs: [run] };
        }
        if (endpoint === "/actions/runs/99") return run;
        if (endpoint === "/deployments/7/statuses") return {};
        throw new Error(`unexpected request ${method} ${endpoint}`);
      },
    };
    await reconcileEffect(api, plan, {
      ledgerVersion: "fixture-v1",
      repository: "owner/repo",
      serverUrl: "https://github.com",
      sourceRunId: "42",
      sourceSha: SOURCE_SHA,
    });
    expect(
      calls.filter(({ endpoint }) => endpoint.endsWith("/dispatches")),
    ).toHaveLength(0);
  });

  test("fails closed when a crashed dispatch cannot be rediscovered", async () => {
    const plan = plans().plans[0];
    const row = payload(plan);
    const calls: Array<{ method: string; endpoint: string }> = [];
    const api = {
      request: async (method: string, endpoint: string) => {
        calls.push({ method, endpoint });
        if (endpoint.startsWith("/deployments?"))
          return [{ id: 7, payload: row }];
        if (endpoint === "/deployments/7/statuses?per_page=1") return [];
        if (endpoint.includes(`/actions/workflows/${plan.workflow}/runs?`)) {
          return { workflow_runs: [] };
        }
        throw new Error(`unexpected request ${method} ${endpoint}`);
      },
    };
    await expect(
      reconcileEffect(api, plan, {
        ledgerVersion: "fixture-v1",
        repository: "owner/repo",
        serverUrl: "https://github.com",
        sourceRunId: "42",
        sourceSha: SOURCE_SHA,
      }),
    ).rejects.toThrow("refusing ambiguous redelivery");
    expect(
      calls.filter(({ endpoint }) => endpoint.endsWith("/dispatches")),
    ).toHaveLength(0);
  });

  test("dispatch requests content-addressed run details", async () => {
    const plan = plans().plans[0];
    let body: Record<string, unknown> | undefined;
    const api = {
      request: async (
        _method: string,
        _endpoint: string,
        value: Record<string, unknown>,
      ) => {
        body = value;
        return { workflow_run_id: 123 };
      },
    };
    expect(await dispatchEffect(api, plan, SOURCE_SHA)).toBe(123);
    expect(body).toMatchObject({ ref: "develop", return_run_details: true });
  });
});

describe("develop-green-only promotion", () => {
  test("allows only an exact current fast-forward or idempotent reconciliation", () => {
    expect(
      decidePromotion({
        comparison: "ahead",
        developSha: SOURCE_SHA,
        mainSha: MAIN_SHA,
        sourceSha: SOURCE_SHA,
      }).action,
    ).toBe("fast-forward");
    expect(
      decidePromotion({
        comparison: "identical",
        developSha: SOURCE_SHA,
        mainSha: SOURCE_SHA,
        sourceSha: SOURCE_SHA,
      }).action,
    ).toBe("reconcile-success");
    expect(
      decidePromotion({
        comparison: "ahead",
        developSha: PRIOR_SHA,
        mainSha: MAIN_SHA,
        sourceSha: SOURCE_SHA,
      }).action,
    ).toBe("stale");
    for (const comparison of ["behind", "diverged"]) {
      expect(() =>
        decidePromotion({
          comparison,
          developSha: SOURCE_SHA,
          mainSha: MAIN_SHA,
          sourceSha: SOURCE_SHA,
        }),
      ).toThrow("cannot fast-forward");
    }
  });

  test("atomically fences develop and main at the mutation boundary", async () => {
    let variables: Record<string, unknown> | undefined;
    const api = {
      graphql: async (_query: string, value: Record<string, unknown>) => {
        variables = value;
        return { updateRefs: { clientMutationId: "ok" } };
      },
    };
    await atomicallyPromoteRefs(api, {
      repositoryId: "R_fixture",
      sourceBranch: "develop",
      sourceSha: SOURCE_SHA,
      targetBranch: "main",
      targetSha: MAIN_SHA,
    });
    expect(variables).toMatchObject({
      input: {
        repositoryId: "R_fixture",
        refUpdates: [
          {
            name: "refs/heads/develop",
            beforeOid: SOURCE_SHA,
            afterOid: SOURCE_SHA,
          },
          {
            name: "refs/heads/main",
            beforeOid: MAIN_SHA,
            afterOid: SOURCE_SHA,
          },
        ],
      },
    });
  });

  test("an advanced develop ref rejects the whole promotion mutation", async () => {
    let mainMoved = false;
    const api = {
      graphql: async (
        _query: string,
        variables: {
          input: {
            refUpdates: Array<{ afterOid: string; beforeOid: string }>;
          };
        },
      ) => {
        const [develop, main] = variables.input.refUpdates;
        if (develop.beforeOid !== PRIOR_SHA) {
          throw new Error("develop beforeOid mismatch");
        }
        mainMoved = main.afterOid === SOURCE_SHA;
      },
    };
    await expect(
      atomicallyPromoteRefs(api, {
        repositoryId: "R_fixture",
        sourceBranch: "develop",
        sourceSha: SOURCE_SHA,
        targetBranch: "main",
        targetSha: MAIN_SHA,
      }),
    ).rejects.toThrow("beforeOid mismatch");
    expect(mainMoved).toBe(false);
  });

  test("dry reconciliation stops stale sources and exposes partial resume", () => {
    const effectPlans = plans();
    expect(
      simulateReconciliation({
        plans: effectPlans,
        sourceSha: SOURCE_SHA,
        state: {
          comparison: "ahead",
          deployments: {},
          developSha: PRIOR_SHA,
          mainSha: MAIN_SHA,
        },
      }),
    ).toEqual({
      sourceSha: SOURCE_SHA,
      stale: true,
      effects: [],
      promotion: "stale",
    });
    const plan = effectPlans.plans[0];
    const result = simulateReconciliation({
      plans: effectPlans,
      sourceSha: SOURCE_SHA,
      state: {
        comparison: "ahead",
        deployments: {
          [plan.id]: [deployment(plan, { state: "in_progress" })],
        },
        developSha: SOURCE_SHA,
        mainSha: MAIN_SHA,
      },
    });
    expect(result.effects).toEqual([
      { id: plan.id, inputDigest: plan.inputDigest, action: "resume" },
    ]);
    expect(result.promotion).toBe("fast-forward");
  });
});

describe("checked-in workflow authority", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const readWorkflow = (name: string) =>
    readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");

  test("reconciliation is dispatch-only, non-cancelable, and least scoped", () => {
    const workflow = Bun.YAML.parse(readWorkflow("develop-reconcile.yml")) as {
      on: Record<string, unknown>;
      concurrency: Record<string, unknown>;
      permissions: Record<string, string>;
    };
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.concurrency).toEqual({
      group: "develop-effect-reconcile",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(workflow.permissions).toEqual({
      actions: "write",
      contents: "write",
      deployments: "write",
    });
  });

  test("every registered mutation accepts a reconciler digest and exact SHA", () => {
    const checkedIn = JSON.parse(
      readFileSync(path.join(repoRoot, ".github/develop-effects.json"), "utf8"),
    ) as ReturnType<typeof registry>;
    for (const effect of checkedIn.effects) {
      const workflow = readWorkflow(effect.workflow);
      expect(workflow).toContain("effect_digest:");
      expect(workflow).toContain(`${effect.shaInput}:`);
      expect(workflow).toContain("Invalid reconciled effect digest");
    }
  });

  test("the handoff requires a successful aggregate and exact run-id response", () => {
    const developFull = readWorkflow("develop-full.yml");
    expect(developFull).toContain("needs.complete.result == 'success'");
    expect(developFull).toContain("X-GitHub-Api-Version: 2026-03-10");
    expect(developFull).toContain(".workflow_run_id");
    expect(developFull).toContain("-F return_run_details=true");
    expect(developFull).toContain('-f "ref=$SOURCE_SHA"');
    expect(developFull).not.toContain("pull_request:");
    expect(readWorkflow("develop-reconcile.yml")).toContain(
      '[[ "$GITHUB_SHA" == "$SOURCE_SHA" ]]',
    );
  });

  test("untrusted dispatch inputs enter shells only through environment variables", () => {
    const reconcile = Bun.YAML.parse(readWorkflow("develop-reconcile.yml")) as {
      jobs: { reconcile: { steps: Array<{ run?: string }> } };
    };
    const scripts = reconcile.jobs.reconcile.steps
      .map((step) => step.run ?? "")
      .join("\n");
    expect(scripts).not.toContain("${{ inputs.");
    expect(scripts).toContain('"$SOURCE_SHA"');
    expect(scripts).toContain('"$SOURCE_RUN_ID"');
  });
});
