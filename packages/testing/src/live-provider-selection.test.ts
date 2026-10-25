import { afterEach, describe, expect, it, vi } from "vitest";
import { selectLiveProvider } from "./live-provider.ts";

afterEach(() => vi.unstubAllEnvs());

describe("explicit live provider selection", () => {
  it("keeps Cerebras selected when an OpenAI key is also configured", () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-openai");
    vi.stubEnv("CEREBRAS_API_KEY", "fixture-cerebras");
    vi.stubEnv("OPENAI_BASE_URL", "https://openai.invalid/v1");
    vi.stubEnv("CEREBRAS_BASE_URL", "https://cerebras.invalid/v1");
    const provider = selectLiveProvider("cerebras");
    expect(provider?.name).toBe("cerebras");
    expect(provider?.env.OPENAI_API_KEY).toBe("fixture-cerebras");
    expect(provider?.env.OPENAI_BASE_URL).toBe("https://cerebras.invalid/v1");
    expect(selectLiveProvider("openai")?.apiKey).toBe("fixture-openai");
  });
});
