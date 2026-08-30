import { describe, expect, test } from "bun:test";

describe("inference strong-revocation rollout", () => {
  test("soaks revocation-fenced auth caching in staging without enabling production", async () => {
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as {
      env?: {
        staging?: { vars?: Record<string, string> };
        production?: { vars?: Record<string, string> };
      };
    };

    expect(config.env?.staging?.vars?.INFERENCE_AUTH_CACHE_ENABLED).toBe(
      "true",
    );
    expect(config.env?.staging?.vars?.INFERENCE_STRONG_REVOCATION_ENABLED).toBe(
      "true",
    );
    expect(config.env?.production?.vars?.INFERENCE_AUTH_CACHE_ENABLED).toBe(
      "true",
    );
    expect(
      config.env?.production?.vars?.INFERENCE_STRONG_REVOCATION_ENABLED,
    ).toBe("false");
  });
});
