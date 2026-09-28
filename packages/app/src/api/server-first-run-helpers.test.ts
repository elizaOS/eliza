/**
 * First-run key persistence must persist the key the user just typed. An
 * ambient provider env var (for example a revoked shell `OPENAI_API_KEY`) is
 * only a fallback for a masked echo of the server's own redacted value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentMocks = vi.hoisted(() => ({
  applyFirstRunCredentialPersistence: vi.fn(
    async (
      _config: Record<string, unknown>,
      _args: { credentialInputs?: { llmApiKey?: string } | null },
    ): Promise<string | null> => "OPENAI_API_KEY",
  ),
  loadElizaConfig: vi.fn(() => ({})),
  saveElizaConfig: vi.fn(),
}));

vi.mock("@elizaos/agent", () => agentMocks);

import { extractAndPersistFirstRunApiKey } from "./server-first-run-helpers";

const directOpenAiBody = (llmApiKey: string) => ({
  serviceRouting: { llmText: { backend: "openai", transport: "direct" } },
  credentialInputs: { llmApiKey },
});

describe("extractAndPersistFirstRunApiKey", () => {
  let previousOpenAiKey: string | undefined;

  beforeEach(() => {
    previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-stale-shell-key";
    agentMocks.applyFirstRunCredentialPersistence.mockClear();
  });

  afterEach(() => {
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
  });

  it("persists a fresh user-supplied key instead of the provider env var", async () => {
    await expect(
      extractAndPersistFirstRunApiKey(directOpenAiBody("sk-fresh-user-key")),
    ).resolves.toBe("OPENAI_API_KEY");
    const [, args] =
      agentMocks.applyFirstRunCredentialPersistence.mock.calls[0] ?? [];
    expect(args?.credentialInputs?.llmApiKey).toBe("sk-fresh-user-key");
  });

  it("replaces a masked echo with the resolved provider env var", async () => {
    await extractAndPersistFirstRunApiKey(directOpenAiBody("****-key"));
    const [, args] =
      agentMocks.applyFirstRunCredentialPersistence.mock.calls[0] ?? [];
    expect(args?.credentialInputs?.llmApiKey).toBe("sk-stale-shell-key");
  });

  it("refuses to persist a masked key when no real key resolves", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(
      extractAndPersistFirstRunApiKey(directOpenAiBody("****-key")),
    ).resolves.toBeNull();
    expect(
      agentMocks.applyFirstRunCredentialPersistence,
    ).not.toHaveBeenCalled();
  });
});
