/** Authenticated BGE route qualification for the Railway sidecar retirement. */
import { expect, test } from "bun:test";

const live = process.env.ELIZA_EMBEDDING_LIVE_CLOUDFLARE === "1";
const qualify = live ? test : test.skip;

qualify(
  "canonical BGE embeddings preserve dimensions and representation",
  async () => {
    const environment = process.env.ELIZA_EMBEDDING_CLOUD_ENVIRONMENT;
    const commit = process.env.ELIZA_EMBEDDING_CLOUD_COMMIT;
    const key = process.env.ELIZAOS_CLOUD_API_KEY;
    if (environment !== "staging" && environment !== "production") {
      throw new Error(
        "A protected staging or production environment is required",
      );
    }
    if (!commit || !/^[a-f0-9]{40}$/.test(commit) || !key) {
      throw new Error(
        "An exact deployed commit and API credential are required",
      );
    }
    const base =
      environment === "production"
        ? "https://api.eliza.app"
        : "https://api-staging.eliza.app";
    const verifyRelease = async () => {
      const response = await fetch(`${base}/api/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ commit, environment });
    };
    await verifyRelease();
    const input = [
      "The migration fixture remembers a blue umbrella.",
      "The migration fixture remembers a blue umbrella.",
    ];
    const request = (dimensions: number) =>
      fetch(`${base}/api/v1/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "bge-small-en-v1.5", input, dimensions }),
        signal: AbortSignal.timeout(90_000),
      });
    const response = await request(384);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      embedding_space?: string;
      model?: string;
      data?: Array<{ index: number; embedding: number[] }>;
    };
    expect(payload.model).toBe("bge-small-en-v1.5");
    expect(payload.embedding_space).toBe(
      "BAAI/bge-small-en-v1.5:cls:l2:384:hf-bert-v1:tail-v1",
    );
    expect(payload.data).toHaveLength(2);
    if (payload.data?.length !== 2) throw new Error("Missing batch vectors");
    for (const [index, item] of payload.data.entries()) {
      expect(item.index).toBe(index);
      expect(item.embedding).toHaveLength(384);
      expect(item.embedding.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...item.embedding)).toBeCloseTo(1, 5);
    }
    const [first, second] = payload.data;
    expect(
      first.embedding.reduce(
        (sum, value, index) => sum + value * second.embedding[index],
        0,
      ),
    ).toBeGreaterThan(0.99999);
    const invalid = await request(768);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "invalid_value" },
    });
    await verifyRelease();
  },
  240_000,
);
