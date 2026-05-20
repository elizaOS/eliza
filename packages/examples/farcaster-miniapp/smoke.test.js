import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Farcaster miniapp shell", () => {
  test("initializes the Farcaster SDK before showing chat", () => {
    const app = read("src/App.tsx");

    expect(app).toContain('from "@farcaster/miniapp-sdk"');
    expect(app).toContain("sdk.actions.ready()");
    expect(app).toContain("<LoadingScreen");
    expect(app).toContain("<ElizaChat");
    expect(app).toContain("Retry");
  });

  test("keeps the local API chat-only with in-memory sessions", () => {
    const server = read("server.js");

    expect(server).toContain('app.get("/health"');
    expect(server).toContain('app.post("/api/chat/eliza"');
    expect(server).toContain("const sessions = new Map()");
    expect(server).toContain("getOrCreateSession");
    expect(server).toContain("buildReply");
  });
});
