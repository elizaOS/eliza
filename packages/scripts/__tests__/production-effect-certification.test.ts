/** Exercises production effect admission and dispatch ordering with real certificate ZIP files and controlled GitHub responses. */
import { afterAll, expect, spyOn, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  CERTIFICATION_FILENAME,
  CERTIFICATION_WORKFLOW,
  createStagingReleaseCertification,
} from "../../cloud/scripts/staging-release-certification.mjs";
import {
  createLedgerPayload,
  reconcileBranchEffects,
} from "../develop-effect-ledger.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const temporary = mkdtempSync(
  path.join(tmpdir(), "production-admission-proof-"),
);
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
const sourceSha = "a".repeat(40);
const destinationSha = "b".repeat(40);
const treeSha = "c".repeat(40);
const repository = "elizaOS/eliza";
const previous = JSON.parse(
  readFileSync(path.join(repoRoot, ".github/staging-effects.json"), "utf8"),
);
const destination = JSON.parse(
  readFileSync(path.join(repoRoot, ".github/main-effects.json"), "utf8"),
);
const plans = {
  promotion: null,
  plans: destination.effects.map((effect) => ({
    ...effect,
    sourceBranch: "main",
    environment: `develop-effect/${effect.id}`,
    inputDigest: "d".repeat(64),
  })),
};

function fixture(
  mode: "valid" | "missing" | "expired" | "wrong-tree" | "digest",
) {
  const issuedAt = new Date(
    Date.now() - (mode === "expired" ? 16 : 1) * 86400000,
  ).toISOString();
  const cert = createStagingReleaseCertification({
    repository,
    runId: "70",
    runAttempt: "1",
    sourceSha,
    treeSha: mode === "wrong-tree" ? "e".repeat(40) : treeSha,
    workflowSha256: createHash("sha256")
      .update(readFileSync(path.join(repoRoot, CERTIFICATION_WORKFLOW)))
      .digest("hex"),
    artifactName: `cloud-staging-certification-v1-${mode === "wrong-tree" ? "e".repeat(40) : treeSha}`,
    issuedAt,
  });
  const directory = mkdtempSync(path.join(temporary, "case-"));
  writeFileSync(
    path.join(directory, CERTIFICATION_FILENAME),
    JSON.stringify(cert),
  );
  execFileSync("zip", ["-q", "certificate.zip", CERTIFICATION_FILENAME], {
    cwd: directory,
  });
  const archive = readFileSync(path.join(directory, "certificate.zip"));
  const calls: Array<{ method: string; endpoint: string }> = [];
  const dispatched: string[] = [];
  const api = {
    async request(
      method: string,
      endpoint: string,
      body?: Record<string, unknown>,
    ) {
      calls.push({ method, endpoint });
      if (endpoint.startsWith(`/commits/${destinationSha}/pulls`))
        return [
          {
            merged_at: issuedAt,
            merge_commit_sha: destinationSha,
            head: { ref: "staging", sha: sourceSha, repo: { id: 1 } },
            base: { ref: "main", repo: { id: 1 } },
          },
        ];
      if (endpoint.startsWith("/git/commits/"))
        return { tree: { sha: treeSha } };
      if (endpoint === "/git/ref/heads/main")
        return { object: { sha: destinationSha } };
      if (endpoint.startsWith("/deployments?")) {
        const environment = new URL(
          `https://fixture.invalid${endpoint}`,
        ).searchParams.get("environment");
        const effect = previous.effects.find(
          (entry) => `develop-effect/${entry.id}` === environment,
        );
        return effect
          ? [
              {
                id: effect.id,
                payload: createLedgerPayload({
                  effect: effect.id,
                  workflow: effect.workflow,
                  ledgerVersion: previous.ledgerVersion,
                  sourceSha,
                  sourceRunId: "42",
                  inputDigest: "d".repeat(64),
                }),
              },
            ]
          : [];
      }
      if (endpoint.includes("/statuses?")) return [{ state: "success" }];
      if (endpoint === "/actions/runs/42")
        return {
          id: 42,
          event: "push",
          head_branch: "staging",
          head_sha: sourceSha,
          path: ".github/workflows/develop-full.yml",
          status: "completed",
          conclusion: "success",
        };
      if (endpoint.startsWith("/actions/artifacts?"))
        return {
          artifacts:
            mode === "missing"
              ? []
              : [
                  {
                    id: 71,
                    name: `cloud-staging-certification-v1-${treeSha}`,
                    expired: false,
                    digest: `sha256:${mode === "digest" ? "f".repeat(64) : createHash("sha256").update(archive).digest("hex")}`,
                    workflow_run: { id: 70, head_sha: sourceSha },
                  },
                ],
        };
      if (endpoint === "/actions/runs/70")
        return {
          id: 70,
          run_attempt: 1,
          event: "push",
          head_branch: "staging",
          head_sha: sourceSha,
          path: CERTIFICATION_WORKFLOW,
          status: "completed",
          conclusion: "success",
          repository: { full_name: repository },
        };
      if (endpoint === "/actions/artifacts/71/zip") return archive;
      if (method === "POST" && endpoint === "/deployments")
        return { id: 100 + dispatched.length, payload: body?.payload };
      if (method === "POST" && endpoint.endsWith("/statuses")) return {};
      if (method === "POST" && endpoint.endsWith("/dispatches")) {
        dispatched.push(endpoint.split("/")[3]);
        return { workflow_run_id: 200 + dispatched.length };
      }
      if (endpoint.startsWith("/actions/runs/20"))
        return {
          id: Number(endpoint.split("/").at(-1)),
          event: "workflow_dispatch",
          head_branch: "main",
          head_sha: destinationSha,
          path: `.github/workflows/${dispatched.at(-1)}`,
          status: "completed",
          conclusion: "success",
        };
      throw new Error(`Unexpected GitHub request ${method} ${endpoint}`);
    },
  };
  return { api, calls, dispatched };
}

async function run(api: ReturnType<typeof fixture>["api"]) {
  return reconcileBranchEffects({
    api,
    sourceBranch: "main",
    sourceSha: destinationSha,
    repoRoot,
    plans,
    context: {
      repository,
      serverUrl: "https://github.com",
      sourceSha: destinationSha,
      sourceRunId: "43",
      ledgerVersion: destination.ledgerVersion,
    },
  });
}

for (const mode of ["missing", "expired", "wrong-tree", "digest"] as const) {
  test(`${mode} staging certification prevents every production mutation`, async () => {
    const f = fixture(mode);
    await expect(run(f.api)).rejects.toThrow(/certification|tree/i);
    expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(f.dispatched).toEqual([]);
  });
}

test("valid immutable staging certificate admits the complete ordered production plan", async () => {
  const f = fixture("valid");
  const result = await run(f.api);
  expect(result?.completed.size).toBe(destination.effects.length);
  expect(f.dispatched).toEqual(
    destination.effects.map((effect) => effect.workflow),
  );
  const download = f.calls.findIndex(
    (call) => call.endpoint === "/actions/artifacts/71/zip",
  );
  const firstWrite = f.calls.findIndex((call) => call.method !== "GET");
  expect(download).toBeGreaterThanOrEqual(0);
  expect(download).toBeLessThan(firstWrite);
});

test("a clock advance during current-ref lookup prevents the first production mutation", async () => {
  const f = fixture("valid");
  const current = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(current);
  const original = f.api.request.bind(f.api);
  f.api.request = async (method, endpoint, body) => {
    const result = await original(method, endpoint, body);
    if (endpoint === "/git/ref/heads/main")
      clock.mockReturnValue(current + 16 * 86400000);
    return result;
  };
  try {
    await expect(run(f.api)).rejects.toThrow(/certification expired/i);
    expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

for (const workflow of [
  "deploy-apps-worker.yml",
  "deploy-eliza-provisioning-worker.yml",
]) {
  test(`${workflow} rejects expired admission after the remote lock and before host work`, () => {
    const document = parse(
      readFileSync(path.join(repoRoot, ".github/workflows", workflow), "utf8"),
    );
    const steps = document.jobs.deploy.steps;
    const certificationIndex = steps.findIndex(
      (step) => step.id === "production_certification",
    );
    expect(certificationIndex).toBeGreaterThanOrEqual(0);
    for (const step of steps.filter(
      (step) =>
        step.name?.startsWith("Ensure host prereqs") ||
        step.name?.startsWith("Deploy and restart"),
    )) {
      expect(steps.indexOf(step)).toBeGreaterThan(certificationIndex);
      expect(step.with.envs.split(",")).toContain(
        "PRODUCTION_CERTIFICATION_EXPIRES_EPOCH",
      );
      const script = step.with.script;
      const guard = script.match(
        /if \[ "\$DEPLOY_BRANCH" = main \]; then[\s\S]*?\nfi/,
      );
      if (!guard)
        throw new Error("Remote mutation lacks its production expiry check");
      if (step.name.startsWith("Deploy and restart"))
        expect(guard.index).toBeGreaterThan(script.indexOf("flock -w"));
      for (const expires of [
        "",
        "1",
        String(Math.floor(Date.now() / 1000) + 60),
      ]) {
        const directory = mkdtempSync(path.join(temporary, "remote-"));
        const result = spawnSync(
          "bash",
          ["-c", `set -euo pipefail\n${guard[0]}\ntouch mutation`],
          {
            cwd: directory,
            env: {
              ...process.env,
              DEPLOY_BRANCH: "main",
              PRODUCTION_CERTIFICATION_EXPIRES_EPOCH: expires,
            },
            encoding: "utf8",
          },
        );
        expect(existsSync(path.join(directory, "mutation"))).toBe(
          Number(expires) > 1,
        );
        expect(result.status === 0).toBe(Number(expires) > 1);
      }
    }
  });
}

for (const [workflow, mutation] of [
  ["build-agent-image.yml", 'docker push "$tag"'],
  ["deploy-eliza-provisioning-worker.yml", "bun run db:cloud:migrate"],
]) {
  test(`${workflow} stops its publication command when late production admission fails`, () => {
    const document = parse(
      readFileSync(path.join(repoRoot, ".github/workflows", workflow), "utf8"),
    );
    const step = Object.values(document.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((candidate) => candidate.run?.includes(mutation));
    if (!step) throw new Error("Missing production mutation step");
    const guard = step.run.match(
      /if \[ "\$(?:GITHUB_REF_NAME|DEPLOY_BRANCH)" = main \]; then\s+node packages\/cloud\/scripts\/production-effect-certification\.mjs "\$(?:GITHUB_SHA|DEPLOY_SHA)"\s+fi/,
    );
    if (!guard)
      throw new Error("Production mutation lacks late certification admission");
    expect(
      step.run
        .slice(guard.index + guard[0].length)
        .trimStart()
        .startsWith(mutation),
    ).toBe(true);
    for (const admissionStatus of [0, 1]) {
      const directory = mkdtempSync(path.join(temporary, "publication-"));
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail\nnode() { return "$ADMISSION_STATUS"; }\ndocker() { touch mutation; }\nbun() { touch mutation; }\n${guard[0]}\n${mutation}`,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            ADMISSION_STATUS: String(admissionStatus),
            GITHUB_REF_NAME: "main",
            DEPLOY_BRANCH: "main",
            GITHUB_SHA: destinationSha,
            DEPLOY_SHA: destinationSha,
            tag: "fixture",
          },
          encoding: "utf8",
        },
      );
      expect(existsSync(path.join(directory, "mutation"))).toBe(
        admissionStatus === 0,
      );
      expect(result.status).toBe(admissionStatus);
    }
  });
}
