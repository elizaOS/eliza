/**
 * A Zoom registrant token (`tk`) admits one registrant, so only the bot's
 * navigation may carry it. A real MeetingService session on an in-memory
 * SQLite runtime must hand the token to the adapter and keep it out of the
 * session the API lists, the room and transcript metadata it persists, and the
 * Zoom strategy's join log line. Only the meeting page is a stand-in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger, ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import type { Page } from "playwright-core";
import { expect, it, vi } from "vitest";
import { createMeetingTranscriptionPipeline } from "./pipeline/pipeline.js";
import { createZoomStrategies } from "./platforms/zoom/strategies.js";
import { MeetingService } from "./service.js";
import { ScriptedAdapter } from "./test-support.js";
import { readTranscriptRow } from "./transcripts/meeting-transcript-writer.js";

const REGISTRANT_TK = "Ab3-x_Yz.DQMAAAAUq9Pc0hY";
const REGISTRANT_LINK = `https://us02web.zoom.us/w/84512339087?tk=${REGISTRANT_TK}&pwd=Pass9`;
const JOIN_URL = `https://app.zoom.us/wc/84512339087/join?pwd=Pass9&tk=${REGISTRANT_TK}`;
const STORED_URL = "https://app.zoom.us/wc/84512339087/join?pwd=Pass9";

it("gives the Zoom registrant token to the bot only", async () => {
  const previousStateDir = process.env.ELIZA_STATE_DIR;
  const stateDir = mkdtempSync(join(tmpdir(), "eliza-zoom-registrant-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  const runtime = createSQLiteTestRuntime({
    character: { name: "Notetaker", bio: ["test"] },
    logLevel: "fatal",
    plugins: [
      {
        name: "silent-transcription",
        description: "Returns no words for every meeting window",
        models: { [ModelType.TRANSCRIPTION]: async () => "" },
      },
    ],
  });
  await runtime.initialize({ skipMigrations: true });
  const info = vi.spyOn(logger, "info");
  try {
    const adapter = new ScriptedAdapter("zoom");
    const service = new MeetingService(runtime, {
      adapters: new Map([["zoom", adapter]]),
      createPipeline: createMeetingTranscriptionPipeline,
    });
    const dto = await service.requestJoin({
      platform: "zoom",
      meetingUrl: REGISTRANT_LINK,
    });
    const session = await adapter.started;
    expect(session.config.meetingUrl).toBe(JOIN_URL);

    // The real Zoom join logs before it navigates; stop it at navigation.
    const page = {
      goto: vi.fn(async () => {
        throw new Error("navigation stopped by test");
      }),
    } as unknown as Page;
    await expect(createZoomStrategies().join(page, session)).rejects.toThrow(
      "navigation stopped by test",
    );
    expect(page.goto).toHaveBeenCalledWith(JOIN_URL, expect.anything());

    const row = await runtime.getMemoryById(dto.transcriptId as never);
    const transcript = row ? readTranscriptRow(row) : null;
    const room = await runtime.getRoom(dto.roomId as never);
    const joinLog = info.mock.calls.find(
      ([, message]) =>
        typeof message === "string" && message.includes("Zoom web client"),
    );
    expect({
      requested: dto.meetingUrl,
      listed: service.listSessions().map((s) => s.meetingUrl),
      transcript: transcript?.metadata?.meetingUrl,
      room: room?.metadata?.meetingUrl,
      joinLog: joinLog?.[0],
    }).toEqual({
      requested: STORED_URL,
      listed: [STORED_URL],
      transcript: STORED_URL,
      room: STORED_URL,
      joinLog: { meetingUrl: STORED_URL },
    });

    adapter.end("normal_completion");
    await vi.waitFor(() => {
      expect(service.getSession(dto.id)?.status).toBe("ended");
    });
  } finally {
    info.mockRestore();
    await runtime.stop();
    if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
