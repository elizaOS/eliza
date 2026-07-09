/**
 * Tests for record/removeAppDeployFact — the durable "app is live at <url>" memory facts. Runs against the runtime's in-memory memory store; no SDK involved.
 */
import { describe, expect, it, mock } from "bun:test";
import { makeApp, makeRoomMessage, memoryRuntime } from "./helpers";

mock.module("@elizaos/core", () => ({
  logger: { warn: () => undefined },
  MemoryType: { CUSTOM: "custom" },
}));

const { recordAppDeployFact, removeAppDeployFact } = await import(
  "../src/app-facts.ts"
);

const appIdOf = (m: { metadata?: unknown }) =>
  (m.metadata as { appId?: string } | undefined)?.appId;
const metadataOf = (m: { metadata?: unknown }) =>
  m.metadata as Record<string, unknown> | undefined;

describe("app deploy facts", () => {
  it("records a durable deploy fact, then removeAppDeployFact purges it", async () => {
    const runtime = memoryRuntime();
    const message = makeRoomMessage("deploy acme");
    const app = makeApp({ id: "id-acme", name: "Acme Bot", slug: "acme-bot" });

    const rec = await recordAppDeployFact(
      runtime,
      message,
      app,
      "https://acme.apps.elizacloud.ai",
    );
    expect(rec.written).toBe(true);
    expect(runtime.__facts.some((m) => appIdOf(m) === "id-acme")).toBe(true);

    const removed = await removeAppDeployFact(runtime, message, "id-acme");
    expect(removed).toBe(true);
    expect(runtime.__facts.some((m) => appIdOf(m) === "id-acme")).toBe(false);
  });

  it("removeAppDeployFact returns false when there is no fact for the app", async () => {
    const runtime = memoryRuntime();
    expect(
      await removeAppDeployFact(runtime, makeRoomMessage("x"), "id-nope"),
    ).toBe(false);
  });

  it("re-deploying updates the single fact in place, and it stays removable", async () => {
    const runtime = memoryRuntime();
    const message = makeRoomMessage("deploy");
    const app = makeApp({ id: "id-x", name: "X App", slug: "x-app" });

    await recordAppDeployFact(
      runtime,
      message,
      app,
      "https://x-1.apps.elizacloud.ai",
    );
    runtime.__facts[0].metadata = {
      ...metadataOf(runtime.__facts[0]),
      sender: { id: "sender-1" },
    };

    const second = await recordAppDeployFact(
      runtime,
      message,
      app,
      "https://x-2.apps.elizacloud.ai",
    );
    expect(second.updated).toBe(true);
    expect(runtime.__facts.filter((m) => appIdOf(m) === "id-x").length).toBe(1);
    expect(metadataOf(runtime.__facts[0])?.appUrl).toBe(
      "https://x-2.apps.elizacloud.ai",
    );
    expect(metadataOf(runtime.__facts[0])?.sender).toBeUndefined();

    expect(await removeAppDeployFact(runtime, message, "id-x")).toBe(true);
    expect(runtime.__facts.length).toBe(0);
  });
});
