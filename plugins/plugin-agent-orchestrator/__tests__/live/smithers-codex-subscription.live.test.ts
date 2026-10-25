/**
 * Live end-to-end proof that a real Codex ChatGPT subscription can traverse
 * AcpService, the durable Smithers child process, and the native ACP adapter.
 * The explicit gate keeps credentialed model traffic out of deterministic CI.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AcpService } from "../../src/services/acp-service.js";
import { runDurableTask } from "../../src/services/smithers-task-integration.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const LIVE_TIMEOUT_MS = Number(
  process.env.LIVE_SMITHERS_SUBSCRIPTION_TIMEOUT_MS ?? 180_000,
);
const describeLive =
  process.env.RUN_LIVE_SMITHERS_SUBSCRIPTION === "1" ? describe : describe.skip;

function runtime() {
  const settings: Record<string, string> = {
    ELIZA_ACP_TRANSPORT: "native",
    ELIZA_ACP_SESSION_STORE_BACKEND: "memory",
    ELIZA_CODEX_ACP_SANDBOX_MODE: "read-only",
    ELIZA_CODEX_ACP_APPROVAL_POLICY: "on-request",
  };
  if (process.env.ELIZA_CODEX_ACP_COMMAND) {
    settings.ELIZA_CODEX_ACP_COMMAND = process.env.ELIZA_CODEX_ACP_COMMAND;
  }
  return {
    agentId: AGENT_ID,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getSetting: vi.fn((key: string) => settings[key]),
    reportError: vi.fn(),
    services: new Map<string, unknown[]>(),
  } as never;
}

describeLive(
  "Smithers + native Codex subscription (live, gated by RUN_LIVE_SMITHERS_SUBSCRIPTION=1)",
  () => {
    it(
      "returns an exact nonce using ~/.codex subscription auth",
      async () => {
        const authPath = join(homedir(), ".codex", "auth.json");
        expect(
          existsSync(authPath),
          "RUN_LIVE_SMITHERS_SUBSCRIPTION=1 requires an authenticated ~/.codex/auth.json",
        ).toBe(true);

        const workdir = mkdtempSync(join(tmpdir(), "smithers-codex-live-"));
        const previousOpenAiKey = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        let service: AcpService | undefined;
        try {
          service = new AcpService(runtime());
          await service.start();
          const session = await service.spawnSession({
            agentType: "codex",
            workdir,
            approvalPreset: "readonly",
            name: "smithers-codex-subscription-live",
          });
          const nonce = `SMITHERS_CODEX_${randomUUID().replaceAll("-", "")}`;
          const result = await runDurableTask(
            service,
            session,
            `Reply with exactly this nonce and no other text: ${nonce}`,
            {
              tenantId: AGENT_ID,
              timeoutMs: LIVE_TIMEOUT_MS,
            },
          );

          expect(result.status).toBe("completed");
          expect(result.lastResponse.trim()).toBe(nonce);
          await service.stopSession(session.sessionId);
        } finally {
          await service?.stop();
          rmSync(workdir, { recursive: true, force: true });
          if (previousOpenAiKey === undefined)
            delete process.env.OPENAI_API_KEY;
          else process.env.OPENAI_API_KEY = previousOpenAiKey;
        }
      },
      LIVE_TIMEOUT_MS + 30_000,
    );
  },
);
