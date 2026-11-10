/** Runs the real admission gate while the native SQL fixture owns primary effects. */
import { fileURLToPath } from "node:url";
import type { RuntimeDurableObjectNamespace } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Miniflare } from "miniflare";

let runtimePromise: Promise<Miniflare> | undefined;

async function createRuntime() {
  const result = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL(
          "../../test/fixtures/inference-admission-gate-worker.ts",
          import.meta.url,
        ),
      ),
    ],
    target: "node",
    format: "esm",
    external: ["node:async_hooks"],
    conditions: ["eliza-source"],
    plugins: [
      {
        name: "standing-fence-delegation-boundary",
        setup(build) {
          // These unused controllers and lease alarm recovery have separate
          // primary owners. Any unexpected call is a failed proof.
          for (const [filter, source] of [
            [
              /inference-funded-budget-controller\.ts$/,
              "export class InferenceFundedBudgetController { constructor(){ throw Error('Unexpected funded controller'); } }",
            ],
            [
              /maps-request-allowance-controller\.ts$/,
              "export class MapsRequestAllowanceController { constructor(){ throw Error('Unexpected Maps controller'); } }",
            ],
            [
              /shared[/]src[/]lib[/]services[/]inference-admission-recovery\.ts$/,
              "export async function recoverExpiredInferenceAdmissionLease(){ throw Error('Unexpected lease alarm'); }",
            ],
            [
              /shared[/]src[/]db[/]client\.ts$/,
              "export const runWithDbCacheAsync=()=>{throw Error('Unexpected gate database access')};",
            ],
            [
              /shared[/]src[/]lib[/]utils[/]logger\.ts$/,
              "export const logger={debug(){},info(){},warn(){},error(){}};",
            ],
          ] as const) {
            build.onLoad({ filter }, () => ({
              contents: source,
              loader: "js",
            }));
          }
        },
      },
    ],
  });
  if (!result.success || !result.outputs[0])
    throw new AggregateError(
      result.logs,
      "Cannot bundle real standing fence gate",
    );
  const { Miniflare } = await import("miniflare");
  return new Miniflare({
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: true,
    script: `${await result.outputs[0].text()}
      const nativeFenceNow = Date.now.bind(Date);
      let nativeFenceAdvance = 0;
      Date.now = () => nativeFenceNow() + nativeFenceAdvance;
      export class NativeStandingFenceGate extends TestInferenceAdmissionGate {
        async fetch(request) {
          if (new URL(request.url).pathname === '/test-advance-fence-clock') {
            nativeFenceAdvance += (await request.json()).milliseconds;
            return new Response(null, {status:204});
          }
          return super.fetch(request);
        }
      }
    `,
    durableObjects: {
      INFERENCE_ADMISSION_GATES: {
        className: "NativeStandingFenceGate",
        useSQLite: true,
      },
    },
  });
}

export async function closeNativeStandingFences() {
  const runtime = await runtimePromise;
  runtimePromise = undefined;
  await runtime?.dispose();
}

export async function nativeStandingFence(input: {
  organizationId: string;
  userId: string;
  balanceUsd: number;
  balanceRevision: string;
  policyGeneration: string;
}) {
  // Every fixture organization has its own real durable object. Reuse the
  // process so connection startup does not multiply across fault outcomes.
  runtimePromise ??= createRuntime();
  const runtime = await runtimePromise;
  const namespace = await runtime.getDurableObjectNamespace(
    "INFERENCE_ADMISSION_GATES",
  );
  const stub = namespace.get(namespace.idFromName(input.organizationId));
  const post = (pathname: string, body: Record<string, unknown>) =>
    stub.fetch(`https://inference-admission.internal${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const snapshot = {
    balanceUsd: input.balanceUsd,
    balanceRevision: input.balanceRevision,
    policyGeneration: input.policyGeneration,
  };
  const hydrated = await post("/hydrate", snapshot);
  await hydrated.arrayBuffer();
  if (!hydrated.ok) {
    throw new Error(
      `Could not hydrate native standing fence (${hydrated.status})`,
    );
  }
  const calls: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const binding: RuntimeDurableObjectNamespace = {
    getByName(organizationId) {
      if (organizationId !== input.organizationId)
        throw new Error("Standing fence escaped fixture tenant");
      return {
        async fetch(input, init) {
          const request = new Request(input, init);
          const pathname = new URL(request.url).pathname;
          const body = (await request.json()) as Record<string, unknown>;
          calls.push({ pathname, body });
          const response = await post(pathname, body);
          return new Response(await response.arrayBuffer(), {
            status: response.status,
            headers: { "content-type": "application/json" },
          });
        },
      };
    },
  };
  async function lease(view: typeof snapshot, estimatedCostUsd: number) {
    const requestId = crypto.randomUUID();
    const response = await post("/lease", {
      ...view,
      organizationId: input.organizationId,
      requestId,
      estimatedCostUsd,
      recovery: {
        version: 1,
        kind: "organization",
        organizationId: input.organizationId,
        userId: input.userId,
        requestId,
        model: "local-fixture",
        provider: "local",
        billingSource: "native-proof",
        description: "native standing fence proof",
        accounting: { kind: "direct_debit" },
      },
    });
    return { requestId, status: response.status, body: await response.json() };
  }
  return {
    binding,
    calls,
    get paths() {
      return calls.map((call) => call.pathname);
    },
    tryOriginalSnapshot: () => lease(snapshot, 1),
    trySnapshot: (view: typeof snapshot) => lease(view, 1),
    async republishOriginal() {
      const response = await post("/hydrate", snapshot);
      await response.arrayBuffer();
      if (!response.ok)
        throw new Error("Native test snapshot publication failed");
    },
    async advance(milliseconds: number) {
      const response = await post("/test-advance-fence-clock", {
        milliseconds,
      });
      if (response.status !== 204)
        throw new Error("Native test clock did not advance");
    },
    async dispatch(requestId: string) {
      const response = await post("/dispatch", {
        requestId,
        preProviderCancellationToken: crypto.randomUUID(),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}
