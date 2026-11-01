/**
 * The admission Worker's transfer upload plan and the live state it must
 * start from; runs no Wrangler and calls no Cloudflare.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  API,
  reader,
  setText,
  TARGET,
  type World,
  world,
} from "./production-admission-fixtures.ts";
import { runbookPhases } from "./production-admission-phase-audit.ts";
import type { LivePhase } from "./production-admission-readback.ts";
import {
  requireApiPhase,
  targetDeployPlan,
  uploadFromLivePredecessor,
} from "./production-admission-target-deploy.ts";

const runbook = readFileSync(
  resolve(import.meta.dirname, "../admission-worker/PRODUCTION-TRANSFER.md"),
  "utf8",
);
const rows = Object.fromEntries(
  runbookPhases(runbook).map((row) => [row.phase, row.commit]),
);
// The commit the API serves when the upload starts (phase 2's main commit M
// before phase 3).
const SERVED = "c".repeat(40);
const plan = (
  phase: string,
  deploy: boolean,
  commit = rows[phase],
  apiCommit = SERVED,
) =>
  targetDeployPlan({
    checkout: "/phase",
    commit: commit ?? "e".repeat(40),
    phase,
    outdir: "/out/bundle",
    deploy,
    apiCommit,
    runtime: "/bun",
    runbook,
  });

describe("admission Worker transfer uploads", () => {
  test("a phase upload validates, builds and deploys only the admission Worker", () => {
    const commit = rows["target-pending"];
    const wrangler = [
      "/bun",
      "/phase/packages/cloud/api/node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "--config",
      "/phase/packages/cloud/admission-worker/wrangler.toml",
      "--env",
      "production",
    ];
    expect(plan("target-pending", true)).toEqual({
      validate: [
        "/bun",
        "/phase/packages/cloud/admission-worker/verify-staging-contract.ts",
        "--production",
        "--phase",
        "target-pending",
      ],
      dryRun: [...wrangler, "--dry-run", "--outdir", "/out/bundle"],
      deploy: {
        predecessor: { phase: "source-owned", commits: { api: SERVED } },
        command: [
          ...wrangler,
          "--var",
          `ELIZA_DEPLOY_COMMIT:${commit}`,
          "--tag",
          commit,
        ],
      },
      cwd: "/phase/packages/cloud/api",
    });
    expect(plan("adopted", true).deploy?.command).toContain(
      `ELIZA_DEPLOY_COMMIT:${rows.adopted}`,
    );
    // R2 is a reviewed reverse commit, not a runbook row.
    expect(
      plan("reverse-commit", true, "e".repeat(40)).deploy?.command,
    ).toContain("e".repeat(40));
  });

  test("the API's phases may build the bundle check but never upload", () => {
    for (const phase of [
      "source-owned",
      "source-commit",
      "reverse-pending",
      "reverse-adopted",
    ]) {
      expect(() => plan(phase, true, "e".repeat(40))).toThrow(
        `${phase} does not upload the admission Worker`,
      );
      expect(plan(phase, false, "e".repeat(40)).deploy).toBeUndefined();
    }
  });

  test("a forward phase uploads only its runbook commit", () => {
    expect(() => plan("target-pending", true, rows.adopted)).toThrow(
      `target-pending deploys only the runbook commit ${rows["target-pending"]}`,
    );
    expect(() => plan("adopted", true, "e".repeat(40))).toThrow(
      "adopted deploys only the runbook commit",
    );
    expect(() => plan("bogus", false)).toThrow("Unknown admission phase");
    expect(() => plan("target-pending", false, "HEAD")).toThrow("full commit");
  });
});

describe("an upload starts only from its live predecessor", () => {
  const deployOf = (phase: string, apiCommit = SERVED) => {
    const deploy = plan(phase, true, rows[phase], apiCommit).deploy;
    if (!deploy) throw new Error(`${phase} has no upload`);
    return deploy;
  };
  // The live state after `phase`, each Worker on the commit it serves.
  const live = (
    phase: LivePhase,
    commits: { api?: string; target?: string } = {},
  ) => {
    const state = world(phase);
    for (const [script, commit] of [
      [API, commits.api],
      [TARGET, commits.target],
    ])
      if (script && commit)
        setText(state.scripts[script].bindings, "ELIZA_DEPLOY_COMMIT", commit);
    return state;
  };
  // What `--deploy` does against this account: the readback, then the upload.
  let uploads: string[][] = [];
  beforeEach(() => {
    uploads = [];
  });
  const attempt = (state: World, phase: string) =>
    uploadFromLivePredecessor(
      deployOf(phase),
      { read: reader(state), api: API, target: TARGET },
      (command) => uploads.push(command),
    );
  const PENDING = rows["target-pending"];

  test("each upload names the step before it and the commits it serves", () => {
    expect(deployOf("target-pending").predecessor).toEqual({
      phase: "source-owned",
      commits: { api: SERVED },
    });
    // Phase 3 also needs the target still on phase 1.
    expect(deployOf("adopted").predecessor).toEqual({
      phase: "source-commit",
      commits: { api: SERVED, target: PENDING },
    });
    expect(deployOf("reverse-commit").predecessor).toEqual({
      phase: "reverse-pending",
      commits: { api: SERVED },
    });
    for (const apiCommit of ["", "HEAD"])
      expect(() => deployOf("adopted", apiCommit)).toThrow(
        "--deploy requires --api-commit",
      );
  });

  test("a fully rolled out predecessor lets the upload proceed", async () => {
    expect(
      (await attempt(live("source-owned", { api: SERVED }), "target-pending"))
        .owner,
    ).toBe(API);
    const committed = live("source-commit", { api: SERVED, target: PENDING });
    expect((await attempt(committed, "adopted")).target?.commit).toBe(PENDING);
    expect(
      (
        await attempt(
          live("reverse-pending", { api: SERVED }),
          "reverse-commit",
        )
      ).owner,
    ).toBe(TARGET);
    expect(uploads).toEqual(
      ["target-pending", "adopted", "reverse-commit"].map(
        (phase) => deployOf(phase).command,
      ),
    );
  });

  test("phase 1 refuses a target that already exists or another API commit", async () => {
    await expect(
      attempt(live("target-pending", { api: SERVED }), "target-pending"),
    ).rejects.toThrow(`source-owned requires ${TARGET} to not exist`);
    await expect(
      attempt(live("source-owned"), "target-pending"),
    ).rejects.toThrow(`${API} does not serve commit ${SERVED}`);
    expect(uploads).toEqual([]);
  });

  test("phase 3 refuses until phase 2 has fully rolled out on the reviewed commit", async () => {
    // Phase 2's release is still pending approval or was skipped.
    await expect(
      attempt(live("target-pending", { api: SERVED }), "adopted"),
    ).rejects.toThrow(
      `source-commit requires ${TARGET} to own the namespace, found ${API}`,
    );
    // Phase 2 is still rolling out.
    const rolling = live("source-commit", { api: SERVED, target: PENDING });
    rolling.scripts[API].split = {
      version: "api-v0",
      percentage: 40,
      bindings: world("target-pending").scripts[API].bindings,
    };
    await expect(attempt(rolling, "adopted")).rejects.toThrow(
      `${API} must serve exactly one version at 100%`,
    );
    // The API serves another commit than the reviewed phase 2 main commit.
    await expect(
      attempt(
        live("source-commit", { api: "d".repeat(40), target: PENDING }),
        "adopted",
      ),
    ).rejects.toThrow(`${API} does not serve commit ${SERVED}`);
    // The target moved off phase 1.
    await expect(
      attempt(live("source-commit", { api: SERVED }), "adopted"),
    ).rejects.toThrow(`${TARGET} does not serve commit ${PENDING}`);
    // Phase 3 already ran.
    await expect(
      attempt(live("adopted", { api: SERVED, target: PENDING }), "adopted"),
    ).rejects.toThrow(`source-commit forbids a binding on ${TARGET}`);
    expect(uploads).toEqual([]);
  });

  test("R2 refuses until R1 has fully rolled out", async () => {
    // R1's release has not run: the API still serves the steady commit.
    await expect(
      attempt(live("adopted", { api: "d".repeat(40) }), "reverse-commit"),
    ).rejects.toThrow(`${API} does not serve commit ${SERVED}`);
    const rolling = live("reverse-pending", { api: SERVED });
    rolling.scripts[API].split = {
      version: "api-v0",
      percentage: 40,
      bindings: world("adopted").scripts[API].bindings,
    };
    await expect(attempt(rolling, "reverse-commit")).rejects.toThrow(
      `${API} must serve exactly one version at 100%`,
    );
    expect(uploads).toEqual([]);
  });

  test("phase 1 runs the before-phase-1 source check on the API commit", () => {
    // The live source predates the production validator; it must instead be
    // the chain base's source.
    const base = rows["source-owned"];
    expect(() =>
      requireApiPhase(deployOf("target-pending", base).predecessor, runbook),
    ).not.toThrow();
    // Phase 1's own tree carries other phase 2 path content than the base.
    expect(() =>
      requireApiPhase(deployOf("target-pending", PENDING).predecessor, runbook),
    ).toThrow(
      `API commit ${PENDING} does not match the phase chain; regenerate it:\n.github/workflows/cloud-tests.yml differs from the phase chain's base`,
    );
    // An API commit this checkout does not have stops before any readback.
    expect(() =>
      requireApiPhase(deployOf("target-pending").predecessor, runbook),
    ).toThrow("git diff");
  });

  test("the API commit must be a tree of the predecessor phase", () => {
    expect(() =>
      requireApiPhase(
        {
          phase: "source-commit",
          commits: { api: rows["source-commit"] },
        },
        runbook,
      ),
    ).not.toThrow();
    expect(() =>
      requireApiPhase(
        {
          phase: "source-commit",
          commits: { api: PENDING },
        },
        runbook,
      ),
    ).toThrow(
      `API commit ${PENDING} is not source-commit: error: Expected production admission phase source-commit, found target-pending`,
    );
    // Cloudflare cannot tell `adopted` from `reverse-pending`; the tree can.
    expect(() =>
      requireApiPhase(
        {
          phase: "reverse-pending",
          commits: { api: rows.adopted },
        },
        runbook,
      ),
    ).toThrow(
      "Expected production admission phase reverse-pending, found adopted",
    );
  });
});
