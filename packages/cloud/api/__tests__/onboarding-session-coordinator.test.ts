/**
 * Exercises the real onboarding state machine through its Durable Object
 * owner, including concurrent turn ordering and transport replay.
 */

import { describe, expect, test } from "bun:test";
import type { OnboardingChatResult } from "@/lib/services/eliza-app/onboarding-chat";
import { OnboardingSessionCoordinator } from "../src/onboarding-session-coordinator";

class TestStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

function createCoordinatorHarness(): {
  coordinator: OnboardingSessionCoordinator;
  objectByName(name: string): OnboardingSessionCoordinator;
} {
  const objects = new Map<string, OnboardingSessionCoordinator>();
  const env: Record<string, unknown> = {};
  const objectByName = (name: string): OnboardingSessionCoordinator => {
    let object = objects.get(name);
    if (!object) {
      object = new OnboardingSessionCoordinator(
        { storage: new TestStorage() } as unknown as DurableObjectState,
        env as never,
      );
      objects.set(name, object);
    }
    return object;
  };
  env.ONBOARDING_SESSIONS = {
    getByName: (name: string) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        objectByName(name).fetch(new Request(input, init)),
    }),
  };
  return {
    coordinator: objectByName("platform:discord:user-1"),
    objectByName,
  };
}

function turn(
  coordinator: OnboardingSessionCoordinator,
  message: string,
  idempotencyKey: string,
): Promise<Response> {
  return coordinator.fetch(
    new Request("https://onboarding.test/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "platform:discord:user-1",
        input: {
          sessionId: "platform:discord:user-1",
          message,
          platform: "discord",
          platformUserId: "user-1",
          trustedPlatformIdentity: true,
          idempotencyKey,
        },
      }),
    }),
  );
}

async function readResult(response: Response): Promise<OnboardingChatResult> {
  return (await response.json()) as OnboardingChatResult;
}

describe("OnboardingSessionCoordinator", () => {
  test("serializes concurrent turns and replays a delivery exactly once", async () => {
    const harness = createCoordinatorHarness();
    const { coordinator } = harness;
    const [firstResponse, secondResponse] = await Promise.all([
      turn(coordinator, "My name is Sam", "discord:message-1"),
      turn(coordinator, "Tell me more", "discord:message-2"),
    ]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const first = await readResult(firstResponse);
    const second = await readResult(secondResponse);
    expect(first.session.history).toHaveLength(2);
    expect(second.session.history).toHaveLength(4);
    expect(
      second.session.history.map(
        (message: { content: string }) => message.content,
      ),
    ).toEqual(expect.arrayContaining(["My name is Sam", "Tell me more"]));
    const continuationToken = first.session.continuationToken;
    if (!continuationToken)
      throw new Error("platform session has no continuation token");
    const continuation = await harness
      .objectByName(continuationToken)
      .fetch(
        new Request("https://onboarding.test/resolve", { method: "POST" }),
      );
    expect((await continuation.json()) as unknown).toEqual({
      sessionId: "platform:discord:user-1",
    });

    const replayResponse = await turn(
      coordinator,
      "this changed payload must not execute",
      "discord:message-1",
    );
    expect(replayResponse.status).toBe(200);
    const replay = await readResult(replayResponse);
    expect(replay.reply).toBe(first.reply);
    expect(replay.session).toEqual(first.session);

    const thirdResponse = await turn(
      coordinator,
      "Third turn",
      "discord:message-3",
    );
    const third = await readResult(thirdResponse);
    expect(third.session.history).toHaveLength(6);
    expect(
      third.session.history.filter(
        (message: { content: string }) => message.content === "My name is Sam",
      ),
    ).toHaveLength(1);
    expect(
      third.session.history.some(
        (message: { content: string }) =>
          message.content === "this changed payload must not execute",
      ),
    ).toBe(false);
  });
});
