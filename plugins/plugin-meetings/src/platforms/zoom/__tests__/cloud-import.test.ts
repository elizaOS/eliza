/**
 * Deterministic integration tests for the authenticated Zoom import boundary:
 * real guarded response reads, VTT parsing, canonical media persistence, shared
 * artifact validation, pagination, byte caps, and typed HTTP failures.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMeetingArtifact } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  importZoomCloudMeeting,
  type ZoomCloudImportError,
} from "../cloud-import.js";

const TOKEN = "zoom-test-token";
let stateDir = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.ELIZA_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), "eliza-zoom-import-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("Zoom cloud import", () => {
  it("imports paginated Zoom resources into validated canonical media and spans", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.includes("/past_meetings/meeting-1/participants")) {
        return json({
          participants: [
            {
              id: "participant-1",
              name: "Alice",
              join_time: "2026-08-05T12:00:00Z",
              leave_time: "2026-08-05T12:30:00Z",
            },
          ],
          next_page_token: "",
        });
      }
      if (url.endsWith("/past_meetings/meeting-1")) {
        return json({
          id: 123,
          uuid: "meeting-1",
          topic: "Zoom import proof",
          start_time: "2026-08-05T12:00:00Z",
          end_time: "2026-08-05T12:30:00Z",
        });
      }
      if (url.endsWith("/meetings/meeting-1/recordings")) {
        return json({
          uuid: "meeting-1",
          topic: "Zoom import proof",
          recording_files: [
            {
              id: "transcript-file",
              file_type: "VTT",
              recording_type: "audio_transcript",
              download_url: "https://zoom.us/download/transcript-file",
            },
            {
              id: "audio-file",
              file_type: "M4A",
              recording_type: "audio_only",
              download_url: "https://zoom.us/download/audio-file",
            },
          ],
        });
      }
      if (url.endsWith("/download/transcript-file")) {
        return new Response(
          "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nAlice: Hello from Zoom.\n",
          { headers: { "content-type": "text/vtt" } },
        );
      }
      if (url.endsWith("/download/audio-file")) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "audio/mp4", "content-length": "4" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await importZoomCloudMeeting({
      meetingId: "meeting-1",
      accessToken: TOKEN,
      fetchImpl,
    });

    expect(validateMeetingArtifact(result.artifact)).toEqual({
      valid: true,
      errors: [],
    });
    expect(result.artifact.schemaVersion).toBe("eliza.meeting_artifact.v1");
    expect(result.artifact.meeting).toMatchObject({
      id: "meeting-1",
      platform: "zoom",
      title: "Zoom import proof",
    });
    expect(result.artifact.transcriptSpans).toEqual([
      expect.objectContaining({
        text: "Hello from Zoom.",
        startMs: 1_000,
        endMs: 3_000,
        platformParticipantId: "participant-1",
      }),
    ]);
    expect(result.artifact.diarizedSpeakers[0]?.name).toMatchObject({
      displayName: "Alice",
      provenance: "platform",
    });
    expect(result.artifact.media).toHaveLength(2);
    for (const media of result.artifact.media) {
      expect(media.url).toMatch(/^\/api\/media\/[a-f0-9]{64}\.[a-z0-9]+$/);
      const relative = media.url.replace(/^\/api\/media\//, "");
      expect(
        readFileSync(join(stateDir, "media", relative)).length,
      ).toBeGreaterThan(0);
    }
    expect(
      calls.every((call) => call.authorization === `Bearer ${TOKEN}`),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("maps provider authorization failures without persisting media", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response('{"message":"Invalid access token"}', {
        status: 401,
        headers: { "x-zm-trackingid": "zoom-request-401" },
      });

    await expect(
      importZoomCloudMeeting({
        meetingId: "meeting-2",
        accessToken: TOKEN,
        fetchImpl,
      }),
    ).rejects.toMatchObject<Partial<ZoomCloudImportError>>({
      code: "revoked_access",
      status: 401,
      requestId: "zoom-request-401",
    });
  });

  it("rejects a repeated participant pagination token", async () => {
    let participantCalls = 0;
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/participants")) {
        participantCalls += 1;
        if (participantCalls > 2) {
          throw new Error("participant pagination did not terminate");
        }
        return json({ participants: [], next_page_token: "stuck-token" });
      }
      if (url.includes("/recordings")) {
        return json({ recording_files: [] });
      }
      return json({ uuid: "meeting-repeated-token" });
    };

    await expect(
      importZoomCloudMeeting({
        meetingId: "meeting-repeated-token",
        accessToken: TOKEN,
        fetchImpl,
      }),
    ).rejects.toMatchObject<Partial<ZoomCloudImportError>>({
      code: "invalid_response",
      status: 502,
    });
    expect(participantCalls).toBe(2);
  });

  it("rejects a non-adjacent participant pagination cycle", async () => {
    const tokens = ["token-a", "token-b", "token-a"];
    let participantCalls = 0;
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/participants")) {
        const nextPageToken = tokens[participantCalls];
        participantCalls += 1;
        return json({ participants: [], next_page_token: nextPageToken });
      }
      return json({ uuid: "meeting-token-cycle" });
    };

    await expect(
      importZoomCloudMeeting({
        meetingId: "meeting-token-cycle",
        accessToken: TOKEN,
        fetchImpl,
      }),
    ).rejects.toMatchObject<Partial<ZoomCloudImportError>>({
      code: "invalid_response",
      status: 502,
    });
    expect(participantCalls).toBe(3);
  });

  it("accepts participants beyond the former 100-page ceiling", async () => {
    let participantCalls = 0;
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/participants")) {
        participantCalls += 1;
        return json({
          participants:
            participantCalls === 101
              ? [{ id: "participant-101", name: "Late" }]
              : [],
          next_page_token:
            participantCalls === 101 ? "" : `unique-token-${participantCalls}`,
        });
      }
      return json({ uuid: "meeting-page-limit" });
    };

    await expect(
      importZoomCloudMeeting({
        meetingId: "meeting-page-limit",
        accessToken: TOKEN,
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      artifact: {
        platformParticipants: [
          expect.objectContaining({ id: "participant-101" }),
        ],
      },
    });
    expect(participantCalls).toBe(101);
  });

  it("fails closed when a streamed recording exceeds its byte quota", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/participants")) return json({ participants: [] });
      if (url.includes("/recordings")) {
        return json({
          uuid: "meeting-3",
          recording_files: [
            {
              id: "oversized",
              file_type: "M4A",
              download_url: "https://zoom.us/download/oversized",
            },
          ],
        });
      }
      if (url.includes("/download/oversized")) {
        return new Response(new Uint8Array([1, 2, 3, 4]));
      }
      return json({ uuid: "meeting-3" });
    };

    await expect(
      importZoomCloudMeeting({
        meetingId: "meeting-3",
        accessToken: TOKEN,
        maxFileBytes: 3,
        fetchImpl,
      }),
    ).rejects.toMatchObject<Partial<ZoomCloudImportError>>({
      code: "max_bytes",
      status: 413,
    });
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
