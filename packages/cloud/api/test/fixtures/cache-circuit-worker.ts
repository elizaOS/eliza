import { CACHE_CIRCUIT_COOLDOWN_MS } from "@elizaos/cloud-shared/lib/cache/cache-circuit-clock";
import { CacheClient } from "@elizaos/cloud-shared/lib/cache/client";
import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import { runWithRequestContext } from "@elizaos/cloud-shared/lib/runtime/request-context";
import controlWorker from "../../../admission-worker/src/index";
import { InferenceAdmissionGate } from "../../src/inference-admission-gate";

export class CacheCircuitTestGate extends InferenceAdmissionGate {
  constructor(
    private readonly fixtureState: DurableObjectState,
    env: Record<string, unknown>,
  ) {
    super(fixtureState, env as never);
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__test/storage") {
      await request.arrayBuffer();
      return Response.json(
        Object.fromEntries(await this.fixtureState.storage.list()),
      );
    }
    return super.fetch(request);
  }
}

let client = new CacheClient();
let wall = 1_800_000_000_000;
let releaseLate: (() => void) | undefined;
let lateTask: Promise<unknown> | undefined;
let releaseReceipt: (() => void) | undefined;
let holdReady = false;
let dropGeneration = 0;
let notifyReceipt: (() => void) | undefined;
let delayedReplies = 0;
export default {
  async fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<Response> {
    Date.now = () => wall;
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => wall,
    });
    const body = (await request.json()) as {
      wall?: number;
      generation?: number;
      gate?: string;
      path?: string;
      method?: string;
      ambient?: boolean;
      delayClockReply?: boolean;
    };
    if (body.wall !== undefined) wall = body.wall;
    const namespace = env.INFERENCE_ADMISSION_GATES as DurableObjectNamespace;
    // Inject loss only after the real actor has committed and returned its receipt.
    const wrappedNamespace = {
      getByName(name: string) {
        const stub = namespace.getByName(name);
        return {
          async fetch(input: RequestInfo, init?: RequestInit) {
            const response = await stub.fetch(input, init);
            const receipt = (await response.clone().json()) as {
              generation?: number;
              ready?: boolean;
            };
            if (receipt.generation === dropGeneration)
              throw new Error("Lost real clock acknowledgement");
            if (holdReady && receipt.ready) {
              holdReady = false;
              await new Promise<void>((resolve) => {
                releaseReceipt = resolve;
                notifyReceipt?.();
              });
            }
            if (body.delayClockReply) {
              delayedReplies++;
              try {
                await new Promise((resolve) => setTimeout(resolve, 1000));
              } finally {
                delayedReplies--;
              }
            }
            return response;
          },
        };
      },
    };
    const operation = () =>
      runWithCloudBindingsAsync(
        { ...env, INFERENCE_ADMISSION_GATES: wrappedNamespace },
        async () => {
          const path = new URL(request.url).pathname;
          if (path === "/reset") {
            client = new CacheClient();
            releaseLate = releaseReceipt = undefined;
            holdReady = false;
            dropGeneration = 0;
            await client.set("authority", { version: "original" }, 3600);
            return Response.json({ reset: true });
          }
          if (path === "/late-race") {
            let started!: () => void;
            const admitted = new Promise<void>((resolve) => {
              started = resolve;
            });
            const held = new Promise<void>((resolve) => {
              releaseLate = resolve;
            });
            // Hold the real KV error after an already admitted command. The adapter
            // and its captured KV binding still perform their ordinary operation.
            const adapter = (
              client as unknown as {
                redis: { get: (key: string) => Promise<unknown> };
              }
            ).redis;
            const original = adapter.get.bind(adapter);
            adapter.get = async (key) => {
              try {
                return await original(key);
              } catch (error) {
                if (key.includes("late:")) {
                  started();
                  await held;
                }
                throw error;
              }
            };
            lateTask = client.getWithOutcome(`late:${"x".repeat(600)}`);
            await admitted;
            const replies = [];
            for (let attempt = 0; attempt < 5; attempt++)
              replies.push(await client.getWithOutcome("x".repeat(600)));
            await new Promise((resolve) =>
              setTimeout(resolve, CACHE_CIRCUIT_COOLDOWN_MS + 60),
            );
            holdReady = true;
            const receiptHeld = new Promise<void>((resolve) => {
              notifyReceipt = resolve;
            });
            const oldRead = client.getWithOutcome("authority");
            await receiptHeld;
            dropGeneration = 6;
            releaseLate?.();
            await lateTask;
            releaseReceipt?.();
            const oldOutcome = await oldRead;
            const confirmed = await client.delConfirmed("authority");
            const blocked = !client.isAvailable();
            dropGeneration = 0;
            await new Promise((resolve) =>
              setTimeout(resolve, CACHE_CIRCUIT_COOLDOWN_MS + 60),
            );
            const currentOutcome = await client.getWithOutcome("authority");
            return Response.json({
              oldOutcome,
              confirmed,
              blocked,
              currentOutcome,
            });
          }
          if (path === "/fail") {
            const replies = [];
            for (let attempt = 0; attempt < 5; attempt++)
              replies.push(await client.getWithOutcome("x".repeat(600)));
            return Response.json({ replies, available: client.isAvailable() });
          }
          if (path === "/available")
            return Response.json({ available: client.isAvailable() });
          if (path === "/pending") return Response.json({ delayedReplies });
          if (path === "/delete")
            return Response.json({
              confirmed: await client.delConfirmed("authority"),
            });
          if (path === "/read")
            return Response.json(await client.getWithOutcome("authority"));
          if (path === "/gate") {
            return namespace
              .getByName(body.gate!)
              .fetch(`https://gate${body.path}`, {
                method: body.method ?? "POST",
                ...(body.method === "GET"
                  ? {}
                  : { body: JSON.stringify({ generation: body.generation }) }),
              });
          }
          if (path === "/outer") return controlWorker.fetch();
          return new Response("Not found", { status: 404 });
        },
      );
    return body.ambient
      ? runWithRequestContext(
          { defer: (task) => ctx.waitUntil(task) },
          operation,
        )
      : operation();
  },
};
