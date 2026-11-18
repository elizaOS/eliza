// spec/agent/models/binding.md, "Only a network failure, an outage or a provider issue is retried, and a rate limit ends the call"
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";
import { isModelProviderFallbackError, isModelFundingAuthorityError } from "@elizaos/core";
import { registerCloudModels } from "../src/models/cloud-provider.vibe";
import { probeOwnKeyModels } from "./zz-wp3u2-probe.vibe";
import { registerOwnKeyModels } from "../src/models/own-key-provider.vibe";
import { allowanceExhausted, dropped, echoImages, insufficientCredits, rateLimited, refusal, startCloudFake, text, unavailable, type CloudFake } from "./support/cloud-fake.ts";

let fake: CloudFake;
beforeAll(async () => { fake = await startCloudFake({ deviceKey: "key", models: ["small", "large"] }); });
afterAll(async () => { await fake.close(); });

type Log = { started: string[]; answered: number[]; refused: unknown[] };
function binding(limited = false) {
  const log: Log = { started: [], answered: [], refused: [] };
  let next = 0;
  return {
    log,
    credential: () => Redacted.make("key"),
    startCall: (handler: string, _now: number) => Effect.sync(() => { log.started.push(handler); return limited ? "limited" as const : next++; }),
    answerCall: (id: number, _now: number) => Effect.sync(() => { log.answered.push(id); }),
    refuseCall: (_id: number, _now: number, e: unknown) => Effect.sync(() => { log.refused.push(e); }),
  };
}
function runtime() {
  const models: Record<string, { handler: (rt: unknown, p: unknown) => Promise<unknown>; provider: string }[]> = {};
  return {
    models,
    registerModel: (type: string, handler: (rt: unknown, p: unknown) => Promise<unknown>, provider: string) => { (models[type] ??= []).push({ handler, provider }); },
  };
}
const cloud = () => ({ baseUrl: fake.origin, small: "small", large: "large", image: "vision" });

it("cloud text whole, streamed, image parts and image description", async () => {
  const b = binding(); const rt = runtime();
  registerCloudModels(rt as never, b as never, cloud());
  expect(Object.keys(rt.models).sort()).toEqual(["IMAGE_DESCRIPTION", "TEXT_LARGE", "TEXT_SMALL"]);
  expect(rt.models.TEXT_SMALL!.length).toBe(2);
  fake.script(text("hello"));
  expect(await rt.models.TEXT_SMALL![0]!.handler(rt, { prompt: "hi" })).toBe("hello");
  const call = fake.calls.at(-1)!;
  expect(call.path).toBe("/api/v1/chat/completions");
  expect((call.body as { model: string }).model).toBe("small");
  fake.script(text("a", "b", "c"));
  const chunks: string[] = [];
  expect(await rt.models.TEXT_LARGE![0]!.handler(rt, { prompt: "hi", stream: true, onStreamChunk: (d: string) => { chunks.push(d); } })).toBe("abc");
  expect(chunks).toEqual(["a", "b", "c"]);
  fake.script(echoImages());
  expect(await rt.models.TEXT_LARGE![0]!.handler(rt, { messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", image: "https://img.example/a.png" }] }] })).toBe("images:https://img.example/a.png");
  fake.script(echoImages());
  const described = await rt.models.IMAGE_DESCRIPTION![0]!.handler(rt, { imageUrl: "https://img.example/b.png" }) as { title: string; description: string };
  expect(described.description).toBe("images:https://img.example/b.png");
  expect((fake.calls.at(-1)!.body as { model: string }).model).toBe("vision");
  expect(b.log.answered.length).toBe(4);
  expect(b.log.refused).toEqual([]);
});

it("cloud refusals map to core outcomes and account refusals", async () => {
  const b = binding(); const rt = runtime();
  registerCloudModels(rt as never, b as never, cloud());
  const small = rt.models.TEXT_SMALL![0]!.handler;
  const fail = async () => small(rt, { prompt: "hi" }).then(() => { throw new Error("answered"); }, (e: unknown) => e);
  const before = Date.now();
  fake.script(insufficientCredits());
  let e = await fail();
  expect(isModelFundingAuthorityError(e)).toBe(true);
  expect(isModelProviderFallbackError(e)).toBe(false);
  fake.script(allowanceExhausted(before + 60000));
  e = await fail();
  expect(isModelFundingAuthorityError(e)).toBe(true);
  fake.script(rateLimited(before + 5000));
  e = await fail();
  expect((e as { code: string }).code).toBe("MODEL_PROVIDER_RETRY_BUDGET_EXHAUSTED");
  fake.script(unavailable(7));
  e = await fail();
  expect((e as { status: number }).status).toBe(503);
  expect(isModelProviderFallbackError(e)).toBe(true);
  fake.script(dropped());
  e = await fail();
  expect((e as { code: string }).code).toBe("ECONNRESET");
  expect(isModelProviderFallbackError(e)).toBe(true);
  fake.script(refusal(400, "invalid_request"));
  e = await fail();
  expect((e as { status: number }).status).toBe(400);
  expect(isModelProviderFallbackError(e)).toBe(false);
  fake.acceptKey("other");
  e = await fail();
  fake.acceptKey("key");
  expect((e as { status: number }).status).toBe(401);
  expect(isModelProviderFallbackError(e)).toBe(false);
  const refused = b.log.refused as { tag: string; retryAt?: number; resetsAt?: number; retryAfter?: number; reason?: string }[];
  expect(refused.map((r) => r.tag)).toEqual(["CloudInsufficientCredits", "CloudAllowanceExhausted", "CloudRateLimited", "CloudUnavailable", "CloudNetwork", "CloudRefused", "CloudCredentialInvalid"]);
  expect(refused[1]!.resetsAt).toBe(before + 60000);
  expect(refused[2]!.retryAt).toBe(before + 5000);
  expect(refused[3]!.retryAfter).toBeGreaterThanOrEqual(before + 7000);
  expect(refused[6]!.reason).toBe("CredentialUnknown");
  expect(b.log.answered).toEqual([]);
});

it("a caller abort is not an account failure and a limited binding sends nothing", async () => {
  const b = binding(); const rt = runtime();
  registerCloudModels(rt as never, b as never, cloud());
  fake.script({ kind: "hang" });
  const controller = new AbortController();
  const pending = rt.models.TEXT_SMALL![0]!.handler(rt, { prompt: "hi", signal: controller.signal }).then(() => undefined, (e: unknown) => e);
  await new Promise((r) => setTimeout(r, 200));
  controller.abort();
  const e = await pending as { name: string };
  expect(e.name).toBe("AbortError");
  expect(b.log.refused).toEqual([]);
  const limited = binding(true); const rt2 = runtime();
  registerCloudModels(rt2 as never, limited as never, cloud());
  const count = fake.calls.length;
  const l = await rt2.models.TEXT_SMALL![0]!.handler(rt2, { prompt: "hi" }).then(() => undefined, (x: unknown) => x);
  expect((l as { code: string }).code).toBe("MODEL_PROVIDER_RETRY_BUDGET_EXHAUSTED");
  expect(fake.calls.length).toBe(count);
});

it("own key serves text only, classifies refusals and probes models", async () => {
  const b = binding(); const rt = runtime();
  const own = { baseUrl: fake.origin + "/v1", small: "small", large: "large" };
  registerOwnKeyModels(rt as never, b as never, own);
  expect(Object.keys(rt.models).sort()).toEqual(["TEXT_LARGE", "TEXT_SMALL"]);
  expect(rt.models.TEXT_LARGE!.length).toBe(2);
  fake.script(text("own"));
  expect(await rt.models.TEXT_LARGE![0]!.handler(rt, { prompt: "hi" })).toBe("own");
  expect(fake.calls.at(-1)!.path).toBe("/v1/chat/completions");
  fake.script(refusal(429, "x"));
  await rt.models.TEXT_LARGE![0]!.handler(rt, { prompt: "hi" }).catch(() => undefined);
  expect((b.log.refused.at(-1) as { tag: string }).tag).toBe("CloudRateLimited");
  expect(await probeOwnKeyModels(own, "key")).toEqual(["small", "large"]);
  expect(await probeOwnKeyModels({ ...own, large: "missing" }, "key")).toBe("CloudProviderIssue");
  expect(await probeOwnKeyModels(own, "bad")).toBe("CloudCredentialInvalid");
});
