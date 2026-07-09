#!/usr/bin/env bun
/**
 * One real chat turn against the deployed E2E agent, through the production
 * message path: the cloud Worker's bridge route (`POST
 * /api/v1/eliza/agents/{agentId}/bridge`, JSON-RPC `message.send`) forwards to
 * the sandbox bridge, which reaches the agent runtime on the Hetzner box over
 * the tailnet. The `status.get` healthcheck alone lets "agent provisioned but
 * chat dead-ends" regressions (#15347) pass the nightly — this step closes
 * that gap by requiring an actual assistant reply. Exit 0 = the agent replied.
 *
 * The runtime answers HTTP 200 with canned text (`failureKind` set) when its
 * model path is dead, and the bridge fabricates text (`fallback: true`) when
 * the runtime produced no reply — exactly the dead-ends this step exists to
 * catch (#15616). classifyBridgeReply rejects both, rejects known canned
 * strings from pre-`failureKind` runtimes, and requires the per-run proof
 * token in the reply — so a pass means a live model round-tripped THIS
 * message. Attempts retry until HETZNER_E2E_CHAT_TIMEOUT_MS (default 240s) to
 * absorb a cold model path and the occasional paraphrase that drops the token.
 * The success log names which bridge rung (conversation REST, OpenAI-compat,
 * central-channel, …) replied, so a conversation-route-only regression cannot
 * hide behind a fallback rung.
 */

import { randomBytes } from "node:crypto";
import { classifyBridgeReply } from "../bridge-reply-verdict";
import { readState } from "./state-file";

const DEFAULT_BASE_URL = "https://api-staging.elizacloud.ai";
const DEFAULT_TIMEOUT_MS = 240_000;
const RETRY_DELAY_MS = 5_000;
// Per-attempt cap: the Worker's bridge tries up to four inner transports at
// 60-120s each, so a single POST can legitimately take minutes.
const ATTEMPT_TIMEOUT_MS = 130_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[hetzner-e2e-chat] missing env: ${name}`);
    process.exit(1);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BridgeChatEnvelope {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

async function sendChatTurn(
  baseUrl: string,
  apiKey: string,
  agentId: string,
  prompt: string,
  roomId: string,
  token: string,
): Promise<{ reply: string; transport: string }> {
  const response = await fetch(
    `${baseUrl}/api/v1/eliza/agents/${agentId}/bridge`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "hetzner-e2e/1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `chat-${Date.now()}`,
        method: "message.send",
        params: {
          text: prompt,
          roomId,
          userId: `${roomId}-user`,
          source: "hetzner-e2e",
          mode: "simple",
        },
      }),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Chat HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text) as BridgeChatEnvelope;
  if (body.error) {
    throw new Error(
      `Chat JSON-RPC error: ${JSON.stringify(body.error).slice(0, 300)}`,
    );
  }
  const verdict = classifyBridgeReply(body.result, token);
  if (!verdict.ok) {
    throw new Error(
      `${verdict.reason} (transport: ${verdict.transport})` +
        (verdict.reply ? ` — reply: ${verdict.reply.slice(0, 200)}` : ""),
    );
  }
  return { reply: verdict.reply, transport: verdict.transport };
}

async function main(): Promise<void> {
  const apiKey = requireEnv("CLOUD_E2E_API_KEY");
  const baseUrl = (
    process.env.CLOUD_SMOKE_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const timeoutMs = Number.parseInt(
    process.env.HETZNER_E2E_CHAT_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS),
    10,
  );

  const state = readState();
  const agentId = state.agent_id;
  if (!agentId) {
    throw new Error(
      "state file missing agent_id; deploy-agent step must run first",
    );
  }

  const runId =
    state.run_id ??
    `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const roomId = `hetzner-e2e-chat-${runId}`;
  // A per-run token proves the reply is a live model round-trip of THIS
  // message, not a canned string. Phrased without quotes so it cannot match
  // the bridge's fallback-text extraction patterns.
  const token = `hetzner-pong-${runId}`;
  const prompt =
    `You are part of an automated end-to-end test. ` +
    `Reply with one short sentence that contains the token ${token}.`;

  console.log(
    `[hetzner-e2e-chat] sending chat turn to agent ${agentId} (room ${roomId}, timeout ${timeoutMs}ms)`,
  );

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastFailure = "no attempt completed";
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const { reply, transport } = await sendChatTurn(
        baseUrl,
        apiKey,
        agentId,
        prompt,
        roomId,
        token,
      );
      console.log(
        `[hetzner-e2e-chat] agent replied on attempt ${attempt} ` +
          `(${reply.length} chars, transport: ${transport}, token echoed): ${reply.slice(0, 300)}`,
      );
      return;
    } catch (error) {
      // error-policy:J1 retry boundary — each failed attempt is logged and the
      // loop fails loudly at the deadline with the last observed failure.
      lastFailure = error instanceof Error ? error.message : String(error);
      console.log(
        `[hetzner-e2e-chat] attempt ${attempt} failed: ${lastFailure}`,
      );
    }
    if (Date.now() + RETRY_DELAY_MS >= deadline) break;
    await sleep(RETRY_DELAY_MS);
  }

  throw new Error(
    `Agent ${agentId} never produced a real chat reply echoing ${token} within ${timeoutMs}ms ` +
      `(${attempt} attempt${attempt === 1 ? "" : "s"}). Last failure: ${lastFailure}`,
  );
}

await main();
