/** Exercises real Hono/Fal proxy transport and HTML catalog arithmetic with synthetic caller admission and a closed provider transport. */
import { afterAll, expect, mock, spyOn, test } from "bun:test";
import type { FlatBillingCost } from "@/lib/services/ai-billing";

let admitted: FlatBillingCost | undefined;
let wire: Record<string, unknown> | undefined;
let settled: number | undefined;
const originalKey = process.env.FAL_KEY;
mock.module("@/db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntries: async () => [],
    listActiveEntriesForProviderModelPairs: async () => [],
  },
}));
mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller: async () => ({
    user: { id: "synthetic-user", organization_id: "synthetic-org" },
    apiKeyId: "synthetic-key",
    credential: undefined,
  }),
  admitFlatGenerativeOperation: async ({ cost }: { cost: FlatBillingCost }) => {
    admitted = cost;
    return {
      markProviderDispatched: async () => undefined,
      settle: async (amount: number) => {
        settled = amount;
      },
      settleUnknown: async () => {
        throw new Error("Unexpected ambiguous transport");
      },
    };
  },
  asGenerativeCacheApiError: (error: Error) => error,
  getGenerativeExecutionContext: () => undefined,
}));
const { fetchFalCatalogEntries } = await import(
  "@/lib/services/ai-pricing/providers/fal"
);
mock.module("@/lib/services/ai-pricing/providers/gateway", () => ({
  fetchEntriesForSource: async (source: string) =>
    source === "fal" ? fetchFalCatalogEntries() : [],
}));
process.env.FAL_KEY = "synthetic-closed-transport";
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://fal.ai/models/minimax/h3-max/image-to-video") {
        return new Response(
          "<p>Video costs $0.0125 per second at 480p, $0.02 per second at 768p, and $0.04 per second at 1080p.</p>",
        );
      }
      if (url.startsWith("https://fal.ai/models/"))
        return new Response("Unrelated model", { status: 404 });
      if (url === "https://queue.fal.run/minimax/h3-max/image-to-video") {
        const request =
          input instanceof Request ? input : new Request(url, init);
        wire = (await request.json()) as Record<string, unknown>;
        return Response.json({ request_id: "synthetic-unpaid-job" });
      }
      throw new Error(`Closed transport rejected ${url}`);
    },
    { preconnect: fetch.preconnect },
  ),
);
const { default: route } = await import("./route");
afterAll(() => {
  fetchSpy.mockRestore();
  if (originalKey === undefined) delete process.env.FAL_KEY;
  else process.env.FAL_KEY = originalKey;
});
async function post(body: unknown) {
  admitted = undefined;
  wire = undefined;
  settled = undefined;
  return route.request("/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fal-target-url": "https://queue.fal.run/minimax/h3-max/image-to-video",
    },
    body: JSON.stringify(body),
  });
}
test.each([
  [{ prompt: "synthetic" }, 5, 0.02],
  [{ prompt: "synthetic", duration: 15, resolution: "768P" }, 15, 0.02],
  [{ prompt: "synthetic", duration: 5, resolution: "1080P" }, 5, 0.04],
] as const)(
  "quotes the exact native H3 duration and resolution forwarded: %j",
  async (body, duration, rate) => {
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(wire).toEqual(body);
    expect(admitted?.baseTotalCost).toBeCloseTo(duration * rate, 6);
    expect(settled).toBeCloseTo(duration * rate * 1.2, 6);
  },
);
test.each([
  { durationSeconds: 1, duration: 15 },
  { duration_seconds: 1, duration: 15 },
  { durationSeconds: 1 },
  { duration: 0 },
  { duration: -1 },
  { duration: 1.5 },
  { duration: "15" },
  { duration: null },
  { duration: Number.MAX_SAFE_INTEGER + 1 },
  { resolution: "768p" },
  { resolution: ["768P"] },
  { generate_audio: false },
  { audio: false },
  { voice_control: true },
])(
  "rejects noncanonical H3 controls before admission or proxy dispatch: %j",
  async (parameters) => {
    const response = await post({ prompt: "synthetic", ...parameters });
    expect(response.status).toBe(400);
    expect(admitted).toBeUndefined();
    expect(wire).toBeUndefined();
    expect(settled).toBeUndefined();
  },
);
test.each([null, [], "invalid body"])(
  "rejects non-object H3 body before admission: %j",
  async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(admitted).toBeUndefined();
    expect(wire).toBeUndefined();
  },
);
