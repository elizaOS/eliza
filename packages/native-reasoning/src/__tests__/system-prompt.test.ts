import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assembleSystemPrompt,
  clearSystemPromptCache,
} from "../system-prompt.js";

const fakeRuntime: any = {
  agentId: "00000000-0000-0000-0000-000000000001",
  character: { system: "char-system" },
  getMemories: vi.fn(async () => []),
};

const fakeMessage: any = {
  id: "00000000-0000-0000-0000-000000000aaa",
  roomId: "00000000-0000-0000-0000-000000000bbb",
  content: { text: "hi" },
};

let tmp: string;
const origWorkspace = process.env.NATIVE_REASONING_WORKSPACE;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "native-reasoning-"));
  process.env.NATIVE_REASONING_WORKSPACE = tmp;
  clearSystemPromptCache();
});

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  if (origWorkspace === undefined) {
    delete process.env.NATIVE_REASONING_WORKSPACE;
  } else {
    process.env.NATIVE_REASONING_WORKSPACE = origWorkspace;
  }
});

describe("assembleSystemPrompt", () => {
  it("includes character.system and skips missing identity files", async () => {
    const out = await assembleSystemPrompt(fakeRuntime, fakeMessage);
    expect(out).toContain("char-system");
    // None of the identity headers should appear when files are missing.
    expect(out).not.toContain("## Your Identity");
    expect(out).not.toContain("## Your Soul");
  });

  it("includes IDENTITY.md when present, with header", async () => {
    await writeFile(path.join(tmp, "IDENTITY.md"), "i-am-nyx", "utf8");
    const out = await assembleSystemPrompt(fakeRuntime, fakeMessage);
    expect(out).toContain("## Your Identity");
    expect(out).toContain("i-am-nyx");
  });

  it("re-reads only when mtime advances", async () => {
    const f = path.join(tmp, "SOUL.md");
    // Pin mtime to a fixed past second so we can step it forward cleanly.
    await writeFile(f, "soul-v1", "utf8");
    const pinned = new Date("2024-01-01T00:00:00.000Z");
    await utimes(f, pinned, pinned);

    const first = await assembleSystemPrompt(fakeRuntime, fakeMessage);
    expect(first).toContain("soul-v1");

    // Rewrite in place, then pin mtime back to the same instant. The
    // mtime-keyed cache should treat this as unchanged and serve v1.
    await writeFile(f, "soul-v2", "utf8");
    await utimes(f, pinned, pinned);

    const cached = await assembleSystemPrompt(fakeRuntime, fakeMessage);
    expect(cached).toContain("soul-v1");
    expect(cached).not.toContain("soul-v2");

    // Step mtime forward → cache invalidates and we see the new content.
    const future = new Date(pinned.getTime() + 5_000);
    await utimes(f, future, future);

    const fresh = await assembleSystemPrompt(fakeRuntime, fakeMessage);
    expect(fresh).toContain("soul-v2");
  });

  it("clearSystemPromptCache forces re-read", async () => {
    const f = path.join(tmp, "USER.md");
    await writeFile(f, "user-a", "utf8");
    const a = await assembleSystemPrompt(fakeRuntime, fakeMessage);
    expect(a).toContain("user-a");

    // Replace + pin mtime to the same instant — without clear, would stay stale.
    const pinned = new Date("2024-06-15T12:00:00.000Z");
    await utimes(f, pinned, pinned);
    await assembleSystemPrompt(fakeRuntime, fakeMessage); // prime cache at pinned mtime
    await writeFile(f, "user-b", "utf8");
    await utimes(f, pinned, pinned);

    clearSystemPromptCache();
    const b = await assembleSystemPrompt(fakeRuntime, fakeMessage);
    expect(b).toContain("user-b");
  });

  it("handles missing workspace dir gracefully", async () => {
    const missing = path.join(tmp, "does-not-exist");
    process.env.NATIVE_REASONING_WORKSPACE = missing;
    const out = await assembleSystemPrompt(fakeRuntime, fakeMessage);
    expect(out).toContain("char-system");
  });

  it("appends recent room messages when getMemories returns history", async () => {
    const runtime: any = {
      ...fakeRuntime,
      agentId: "agent-id",
      getMemories: vi.fn(async () => [
        // returned newest-first by convention
        {
          id: "m3",
          entityId: "agent-id",
          content: { text: "agent reply" },
        },
        {
          id: "m2",
          entityId: "user-id",
          content: { text: "user follow-up" },
        },
        {
          id: "m1",
          entityId: "user-id",
          content: { text: "user opener" },
        },
      ]),
    };
    const out = await assembleSystemPrompt(runtime, fakeMessage);
    expect(out).toContain("## Recent Conversation");
    expect(out).toContain("user: user opener");
    expect(out).toContain("user: user follow-up");
    expect(out).toContain("agent: agent reply");
    // Chronological order check: opener should come before reply.
    expect(out.indexOf("user opener")).toBeLessThan(out.indexOf("agent reply"));
  });
});

// Silence unused import warning for `mkdir` while keeping the import handy
// in case future tests need it.
void mkdir;
