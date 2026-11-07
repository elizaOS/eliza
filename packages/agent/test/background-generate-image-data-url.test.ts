import { describe, expect, it } from "vitest";
import { backgroundGenerateImageRoute } from "../src/api/background-routes.ts";

const OVERSIZED_DATA_URL = `data:image/png;base64,${"A".repeat(16 * 1024 * 1024)}`;
const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function handlerContext(generated: Record<string, unknown>) {
  return {
    body: { prompt: "a red barn at dusk" },
    runtime: {
      getService: () => ({
        canGenerateMedia: async () => true,
        generateMedia: async () => generated,
      }),
    },
  } as never;
}

describe("POST /api/background/generate-image", () => {
  it("fails instead of answering 200 with an unstorable provider data URL", async () => {
    const response = (await backgroundGenerateImageRoute.routeHandler(
      handlerContext({ imageUrl: OVERSIZED_DATA_URL, mimeType: "image/png" }),
    )) as { status: number; body: { url?: string; error?: string } };

    // Returning the multi-MB data URL as `url` defeats this route's contract:
    // the client would persist it in its config, the exact quota blow-up the
    // content-addressed store exists to prevent.
    expect(response.status).toBe(502);
    expect(response.body.url).toBeUndefined();
  });

  it("keeps re-hosting a storable provider data URL", async () => {
    const response = (await backgroundGenerateImageRoute.routeHandler(
      handlerContext({ imageUrl: ONE_PIXEL_PNG, mimeType: "image/png" }),
    )) as { status: number; body: { url?: string } };

    expect(response.status).toBe(200);
    expect(response.body.url).toMatch(/^\/api\/media\/[0-9a-f]{64}\.png$/);
  });
});
