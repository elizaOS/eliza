/** Real cross-Worker RPC and real admission controller; primary results are a fixture. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

let runtime: Miniflare;
let directory: string;
const primaryFixture = `
function state(){return globalThis.__policyRpcFixture??={policy:null,mutation:{state:'absent'},mode:'ok',policyReads:0,mutationReads:0};}
export async function loadAdmissionPolicy(){const s=state();s.policyReads++;if(s.mode==='unavailable')throw Error('primary unavailable');return s.policy;}
export async function inspectAdmissionPolicyMutation(){const s=state();s.mutationReads++;if(s.mode==='unavailable')throw Error('primary unavailable');return s.mutation;}
`;
const noPrimary = `const fail=()=>{throw Error('Unexpected database access on admission sidecar');};
export const runWithDbCacheAsync=fail,loadInferenceBudgetPolicy=fail,inspectInferencePolicyMutation=fail,
reserveBudget=fail,closeBudget=fail,recordConsumption=fail,recoverExpiredInferenceAdmissionLease=fail;`;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "inference-policy-rpc-"));
  const fixtures = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
  for (const name of ["sidecar", "primary", "control"]) {
    const build = await Bun.build({
      entrypoints: [path.join(fixtures, `inference-policy-rpc-${name}.ts`)],
      outdir: directory,
      target: "node",
      external: ["cloudflare:workers", "node:async_hooks"],
      conditions: ["eliza-source"],
      plugins: [
        {
          name: "policy-rpc-boundaries",
          setup(builder) {
            if (name === "sidecar")
              builder.onResolve(
                {
                  filter:
                    /^@elizaos\/cloud-shared\/lib\/services\/inference-policy-primary$/,
                },
                () => ({
                  path: fileURLToPath(
                    new URL(
                      "../../admission-worker/src/policy-service.ts",
                      import.meta.url,
                    ),
                  ),
                }),
              );
            if (name === "primary")
              builder.onLoad(
                {
                  filter:
                    /shared[/]src[/]lib[/]services[/]inference-policy-primary\.ts$/,
                },
                () => ({ loader: "js", contents: primaryFixture }),
              );
            for (const filter of [
              /shared[/]src[/]db[/]client\.ts$/,
              /shared[/]src[/]lib[/]services[/]inference-funded-budget-admission\.ts$/,
              /shared[/]src[/]lib[/]services[/]inference-policy-fence\.ts$/,
              /shared[/]src[/]db[/]repositories[/]inference-funding-budgets\.ts$/,
              /shared[/]src[/]lib[/]services[/]inference-admission-recovery\.ts$/,
            ])
              builder.onLoad({ filter }, () => ({
                loader: "js",
                contents: noPrimary,
              }));
            builder.onLoad(
              { filter: /shared[/]src[/]lib[/]utils[/]logger\.ts$/ },
              () => ({
                loader: "js",
                contents:
                  "export const logger={debug(){},info(){},warn(){},error(){}};",
              }),
            );
          },
        },
      ],
    });
    if (!build.success)
      throw new AggregateError(build.logs, `Could not bundle ${name}`);
  }
  const common = {
    modulesRoot: directory,
    modules: true as const,
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
  };
  runtime = new Miniflare({
    workers: [
      {
        ...common,
        name: "sidecar",
        scriptPath: path.join(directory, "inference-policy-rpc-sidecar.js"),
        durableObjects: {
          INFERENCE_ADMISSION_GATES: {
            className: "InferenceAdmissionGate",
            useSQLite: true,
          },
        },
        bindings: {
          INFERENCE_RATE_POLICY_ADMISSION: "true",
          INFERENCE_STRONG_REVOCATION_ENABLED: "true",
          INFERENCE_FUNDED_BUDGET_ADMISSION: "false",
        },
        serviceBindings: {
          INFERENCE_RECOVERY_SERVICE: {
            name: "primary",
            entrypoint: "PolicyPrimaryFixture",
          },
        },
      },
      {
        ...common,
        name: "primary",
        scriptPath: path.join(directory, "inference-policy-rpc-primary.js"),
      },
      {
        ...common,
        name: "control",
        scriptPath: path.join(directory, "inference-policy-rpc-control.js"),
        serviceBindings: {
          PRIMARY: { name: "primary", entrypoint: "PolicyPrimaryFixture" },
        },
      },
    ],
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function configure(body: unknown) {
  const control = await runtime.getWorker("control");
  expect(
    (
      await control.fetch("https://fixture.test/configure", {
        method: "POST",
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(204);
}
async function stats() {
  const control = await runtime.getWorker("control");
  return (await (await control.fetch("https://fixture.test/stats")).json()) as {
    policyReads: number;
    mutationReads: number;
  };
}
async function post(
  organizationId: string,
  target: string,
  body: Record<string, unknown>,
) {
  const namespace = await runtime.getDurableObjectNamespace(
    "INFERENCE_ADMISSION_GATES",
    "sidecar",
  );
  const response = await namespace
    .get(namespace.idFromName(organizationId))
    .fetch(`https://private.test${target}`, {
      method: "POST",
      body: JSON.stringify({ organizationId, ...body }),
    });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}
const policy = (organizationId: string, epoch = "1") => ({
  organizationId,
  enabled: false,
  rateEnabled: true,
  epoch,
  policyGeneration: "1",
  validUntil: Date.now() + 120_000,
  rateLimits: {
    completionsRpm: 100,
    embeddingsRpm: 100,
    standardRpm: 100,
    strictRpm: 100,
  },
});
const proof = (epoch = "1") => ({
  policyEpoch: epoch,
  policyGeneration: "1",
  endpointType: "completions",
  credential: {
    kind: "api_key",
    credentialId: "key",
    userId: "user",
    rateLimit: 100,
    expiresAt: null,
  },
  operationId: crypto.randomUUID(),
  operationDeadlineAt: Date.now() + 5_000,
  windowStartedAt: Math.floor(Date.now() / 60_000) * 60_000,
});

test("cold sidecar hydrates by private RPC; warm requests make no primary call", async () => {
  const org = crypto.randomUUID();
  await configure({ policy: policy(org), mode: "ok" });
  const before = await stats();
  expect((await post(org, "/rate-policy/rate", proof())).status).toBe(200);
  expect((await stats()).policyReads).toBe(before.policyReads + 1);
  const warm = await stats();
  for (let i = 0; i < 3; i++)
    expect((await post(org, "/rate-policy/rate", proof())).status).toBe(200);
  expect(await stats()).toEqual(warm);
});

test("mutation commit inspects the primary and retires the old proof", async () => {
  const org = crypto.randomUUID();
  await configure({ policy: policy(org), mode: "ok" });
  expect((await post(org, "/rate-policy/rate", proof())).status).toBe(200);
  const mutationId = crypto.randomUUID();
  const begun = await post(org, "/policy-mutation/begin", { mutationId });
  expect(begun.status).toBe(200);
  await configure({
    policy: policy(org, "2"),
    mutation: {
      state: "applied",
      epoch: "2",
      fenceToken: begun.body.fenceToken,
    },
  });
  const before = await stats();
  expect(
    (
      await post(org, "/policy-mutation/commit", {
        mutationId,
        fenceToken: begun.body.fenceToken,
      })
    ).status,
  ).toBe(200);
  expect(await stats()).toEqual({
    policyReads: before.policyReads + 1,
    mutationReads: before.mutationReads + 1,
  });
  expect((await post(org, "/rate-policy/rate", proof())).status).toBe(503);
  expect((await post(org, "/rate-policy/rate", proof("2"))).status).toBe(200);
});

for (const failure of ["unavailable", "malformed", "wrong organization"]) {
  test(`${failure} policy RPC cannot admit a request`, async () => {
    const org = crypto.randomUUID();
    await configure({
      mode: failure === "unavailable" ? failure : "ok",
      policy:
        failure === "malformed"
          ? { epoch: "1" }
          : policy(
              failure === "wrong organization" ? crypto.randomUUID() : org,
            ),
    });
    expect((await post(org, "/rate-policy/rate", proof())).status).toBe(503);
  });
}

test("malformed mutation RPC leaves its pending fence closed", async () => {
  const org = crypto.randomUUID();
  await configure({ policy: policy(org), mode: "ok" });
  expect((await post(org, "/rate-policy/rate", proof())).status).toBe(200);
  const mutationId = crypto.randomUUID();
  const begun = await post(org, "/policy-mutation/begin", { mutationId });
  await configure({
    mutation: {
      state: "applied",
      epoch: "bad",
      fenceToken: begun.body.fenceToken,
    },
  });
  expect(
    (
      await post(org, "/policy-mutation/commit", {
        mutationId,
        fenceToken: begun.body.fenceToken,
      })
    ).status,
  ).toBe(503);
  const before = await stats();
  expect((await post(org, "/rate-policy/rate", proof())).status).toBe(503);
  expect(await stats()).toEqual(before);
});

test("the sidecar and primary RPC methods have no public HTTP route", async () => {
  for (const name of ["sidecar", "primary"]) {
    const worker = await runtime.getWorker(name);
    for (const target of [
      "/loadAdmissionPolicy",
      "/inspectAdmissionPolicyMutation",
      "/rate-policy/rate",
    ]) {
      const response = await worker.fetch(`https://public.test${target}`, {
        method: "POST",
      });
      await response.arrayBuffer();
      expect(response.status).toBe(404);
    }
  }
});
