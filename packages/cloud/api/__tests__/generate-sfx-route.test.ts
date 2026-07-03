/**
 * POST /api/v1/generate-sfx — route contract tests.
 *
 * Drives the real Hono handler with the provider/auth/pricing seams mocked
 * (same boundaries as the generate-video credit-leak suite) and a faithful
 * credit ledger, covering:
 *  - happy path (byte result stored to R2, generation row written, settled once),
 *  - unsupported model → 400 with the supported list, no reserve,
 *  - per-model duration cap → 400,
 *  - provider not configured → 503, no reserve,
 *  - insufficient credits → 402,
 *  - pre-settle provider failure → full refund,
 *  - post-settle DB failure → charge NOT refunded (money-leak guard).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as audioRegistryActual from "@/lib/providers/audio/registry";
import * as aiPricingActual from "@/lib/services/ai-pricing";
import * as contentSafetyActual from "@/lib/services/content-safety";
import * as creditsActual from "@/lib/services/credits";
import * as generationsActual from "@/lib/services/generations";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const MODEL = "elevenlabs/sound_effects_v1";
const COST = 0.08;

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  RateLimitPresets: { STRICT: { limit: 1, windowSeconds: 1 } },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/content-safety", () => ({
  ...contentSafetyActual,
  contentSafetyService: {
    ...contentSafetyActual.contentSafetyService,
    assertSafeForPublicUse: async () => undefined,
  },
}));

mock.module("@/lib/services/ai-pricing", () => ({
  ...aiPricingActual,
  calculateSfxGenerationCostFromCatalog: async () => ({ totalCost: COST }),
}));

const reserve = mock();
mock.module("@/lib/services/credits", () => ({
  ...creditsActual,
  creditsService: { ...creditsActual.creditsService, reserve },
}));

const generationsCreate = mock();
mock.module("@/lib/services/generations", () => ({
  ...generationsActual,
  generationsService: {
    ...generationsActual.generationsService,
    create: generationsCreate,
  },
}));

const generate = mock();
mock.module("@/lib/providers/audio/registry", () => ({
  ...audioRegistryActual,
  getAudioProvider: () => ({ billingSource: "elevenlabs", generate }),
}));

const sfxRoute = (await import("../v1/generate-sfx/route")).default;

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module("@/lib/services/content-safety", () => contentSafetyActual);
  mock.module("@/lib/services/ai-pricing", () => aiPricingActual);
  mock.module("@/lib/services/credits", () => creditsActual);
  mock.module("@/lib/services/generations", () => generationsActual);
  mock.module("@/lib/providers/audio/registry", () => audioRegistryActual);
});

type AppCtx = { set: (k: string, v: unknown) => void };

function makeLedgerReservation(startBalance: number, hold: number) {
  let balance = startBalance - hold;
  let reconcileCalls = 0;
  let lastActual = Number.NaN;
  return {
    startBalance,
    get balance() {
      return balance;
    },
    get reconcileCalls() {
      return reconcileCalls;
    },
    get lastActual() {
      return lastActual;
    },
    reservation: {
      reservedAmount: hold,
      reconcile: async (actualCost: number) => {
        reconcileCalls++;
        lastActual = actualCost;
        balance += hold - actualCost;
        return undefined;
      },
    },
  };
}

/** In-memory R2 binding — enough surface for putPublicObject. */
function makeFakeBlob() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    binding: {
      put: async (key: string, body: ArrayBuffer | ArrayBufferView) => {
        objects.set(
          key,
          body instanceof ArrayBuffer
            ? new Uint8Array(body)
            : new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
        );
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    },
  };
}

const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);

function post(
  body: Record<string, unknown>,
  env: Record<string, unknown> = {},
) {
  return sfxRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    {
      ELEVENLABS_API_KEY: "xi-test-key",
      ...env,
    } as unknown as Record<string, unknown>,
  );
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  reserve.mockReset();
  generationsCreate.mockReset();
  generate.mockReset();

  requireUserOrApiKeyWithOrg.mockImplementation(async (c: AppCtx) => {
    c.set("apiKeyId", "key-1");
    return {
      id: USER,
      organization_id: ORG,
      organization: { id: ORG, name: "Org", is_active: true },
      is_active: true,
    };
  });
});

describe("generate-sfx — happy path", () => {
  test("byte result is stored to R2, persisted, and settled exactly once", async () => {
    const ledger = makeLedgerReservation(10, COST);
    const blob = makeFakeBlob();
    reserve.mockResolvedValue(ledger.reservation);
    generate.mockResolvedValue({
      source: "bytes",
      bytes: MP3_BYTES,
      contentType: "audio/mpeg",
    });
    generationsCreate.mockResolvedValue({ id: "gen-sfx-1" });

    const res = await post(
      { prompt: "glass shattering", model: MODEL, durationSeconds: 3 },
      { BLOB: blob.binding },
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      success: boolean;
      id: string;
      audio: { url: string; file_size: number; content_type: string };
    };
    expect(payload.success).toBe(true);
    expect(payload.id).toBe("gen-sfx-1");
    expect(payload.audio.url).toContain(`generations/sfx/${ORG}/${USER}/`);
    expect(payload.audio.file_size).toBe(MP3_BYTES.byteLength);

    // The actual bytes landed in R2 under the URL's key.
    expect(blob.objects.size).toBe(1);
    const [key, bytes] = [...blob.objects.entries()][0];
    expect(payload.audio.url.endsWith(key)).toBe(true);
    expect(Array.from(bytes)).toEqual(Array.from(MP3_BYTES));

    // The generation row records the sfx type + storage URL.
    expect(generationsCreate).toHaveBeenCalledTimes(1);
    expect(generationsCreate.mock.calls[0][0]).toMatchObject({
      type: "sfx",
      model: MODEL,
      provider: "elevenlabs",
      status: "completed",
      storage_url: payload.audio.url,
    });

    // Settled exactly once to the real cost.
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(COST, 10);
  });
});

describe("generate-sfx — validation gates (no money moves)", () => {
  test("unsupported model → 400 with the supported list", async () => {
    const res = await post({ prompt: "x", model: "acme/boom-fx" });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as {
      details: { supportedModels: string[] };
    };
    expect(payload.details.supportedModels).toContain(MODEL);
    expect(reserve).not.toHaveBeenCalled();
  });

  test("duration above the per-model cap → 400", async () => {
    // ElevenLabs SFX caps at 30s.
    const res = await post({ prompt: "x", model: MODEL, durationSeconds: 31 });
    expect(res.status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
  });

  test("provider not configured → 503", async () => {
    const res = await sfxRoute.request(
      "/",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer eliza_test_key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "x", model: MODEL }),
      },
      {} as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(503);
    expect(reserve).not.toHaveBeenCalled();
  });

  test("insufficient credits → 402 with required amount", async () => {
    reserve.mockRejectedValue(
      new creditsActual.InsufficientCreditsError(COST, 0),
    );
    const res = await post({ prompt: "x", model: MODEL });
    expect(res.status).toBe(402);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("generate-sfx — settlement", () => {
  test("pre-settle provider failure refunds in full", async () => {
    const ledger = makeLedgerReservation(10, COST);
    reserve.mockResolvedValue(ledger.reservation);
    generate.mockRejectedValue(new Error("upstream 503"));

    const res = await post({ prompt: "x", model: MODEL });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(generationsCreate).not.toHaveBeenCalled();
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });

  test("post-settle DB failure does NOT refund the settled charge", async () => {
    const ledger = makeLedgerReservation(10, COST);
    const blob = makeFakeBlob();
    reserve.mockResolvedValue(ledger.reservation);
    generate.mockResolvedValue({
      source: "bytes",
      bytes: MP3_BYTES,
      contentType: "audio/mpeg",
    });
    generationsCreate.mockRejectedValue(new Error("db write failed"));

    const res = await post(
      { prompt: "x", model: MODEL },
      { BLOB: blob.binding },
    );

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(COST, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);
  });
});
