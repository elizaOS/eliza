/**
 * CODING_SESSION_CHANGES provider truncation honesty: a change set whose
 * capture was cut must be disclosed IN THE MODEL-FACING TEXT with a durable
 * continuation reference — never re-presented as the complete change set —
 * while an untruncated set keeps the strong "this IS the real change set"
 * grounding. Deterministic: stubbed runtime/ACP service, real durable content
 * store on a temp trajectory dir.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codingSessionChangesProvider } from "../providers/coding-session-changes.js";
import { readDurableContent } from "../services/durable-content-store.js";
import type { SessionInfo } from "../services/types.js";

let trajectoryDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  trajectoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-traj-"));
  savedEnv = process.env.ELIZA_TRAJECTORY_DIR;
  process.env.ELIZA_TRAJECTORY_DIR = trajectoryDir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
  else process.env.ELIZA_TRAJECTORY_DIR = savedEnv;
  fs.rmSync(trajectoryDir, { recursive: true, force: true });
});

const ROOM_ID = "room-1";
const DIFF = "diff --git a/a.ts b/a.ts\n+const added = 1;";

function makeSession(truncated: boolean): SessionInfo {
  return {
    id: "s1",
    agentType: "elizaos",
    workdir: "/tmp/nowhere",
    status: "completed",
    approvalPreset: "standard",
    createdAt: new Date(Date.now() - 60_000),
    lastActivityAt: new Date(),
    metadata: {
      roomId: ROOM_ID,
      label: "test task",
      lastChangeSet: {
        changedFiles: ["a.ts"],
        diffStat: "1 file changed",
        diff: DIFF,
        truncated,
        capturedAt: Date.now(),
      },
    },
  } as SessionInfo;
}

function makeRuntime(session: SessionInfo): IAgentRuntime {
  return {
    getService: (name: string) =>
      name === "ACP_SERVICE" ? { listSessions: () => [session] } : undefined,
  } as unknown as IAgentRuntime;
}

const message = { roomId: ROOM_ID } as unknown as Memory;
const state = {} as State;

describe("CODING_SESSION_CHANGES — capture-cut disclosure", () => {
  it("a truncated change set is disclosed as PARTIAL with a durable reference", async () => {
    const result = await codingSessionChangesProvider.get(
      makeRuntime(makeSession(true)),
      message,
      state,
    );
    const text = result.text ?? "";
    // The diff itself still flows whole into the text…
    expect(text).toContain("+const added = 1;");
    // …but the cut is disclosed, never re-presented as complete.
    expect(text).toContain("truncated: true");
    expect(text).toContain("PARTIAL");
    expect(text).not.toContain("ARE the real change set");
    // The disclosure names a resolvable durable record of the captured diff.
    const sha = /\/api\/orchestrator\/content\/([0-9a-f]{64})/.exec(text)?.[1];
    expect(sha).toBeTruthy();
    expect(readDurableContent(sha ?? "", { limit: 65_536 })?.text).toBe(DIFF);
    // The data payload carries the same honest flag.
    expect(
      (result.data as { recentCodingChanges?: { truncated?: boolean } })
        ?.recentCodingChanges?.truncated,
    ).toBe(true);
  });

  it("an untruncated change set keeps the strong completeness grounding", async () => {
    const result = await codingSessionChangesProvider.get(
      makeRuntime(makeSession(false)),
      message,
      state,
    );
    const text = result.text ?? "";
    expect(text).toContain("ARE the real change set");
    expect(text).not.toContain("truncated: true");
    expect(text).toContain("+const added = 1;");
  });
});
