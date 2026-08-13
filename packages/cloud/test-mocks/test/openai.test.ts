/** Exercises the real HTTP contract exposed by the deterministic OpenAI mock. */

import { afterEach, describe, expect, test } from "bun:test";
import { type RunningOpenAiMock, startOpenAiMock } from "../src/openai/server";

let running: RunningOpenAiMock | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe("OpenAI mock", () => {
  test("returns a usage-bearing context echo", async () => {
    running = await startOpenAiMock({ echoContext: true });
    const response = await fetch(`${running.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/local",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ack" },
          { role: "user", content: "second" },
        ],
      }),
    });
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };
    expect(response.status).toBe(200);
    expect(body.choices[0]?.message.content).toBe(
      "turn 2 (prior user turns: 1): second",
    );
    expect(body.usage.total_tokens).toBeGreaterThan(0);
    expect(running.requestCount()).toBe(1);
  });
});
