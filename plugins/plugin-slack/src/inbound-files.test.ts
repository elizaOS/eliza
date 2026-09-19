/**
 * Inbound Slack files must reach `Media` with the fetchable `url_private` /
 * `url_private_download` URL Slack actually sends (#31767). Deterministic:
 * the boundary mapper is exercised directly and through the real
 * `buildMemoryFromMessage` with the service's lookups stubbed.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { normalizeSlackFiles, slackFilesToMedia } from "./inbound-files";
import { SlackService } from "./service";

const wireFile = {
  id: "F0001",
  name: "report.pdf",
  title: "report",
  mimetype: "application/pdf",
  filetype: "pdf",
  size: 1234,
  url_private: "https://files.slack.com/files-pri/T0001-F0001/report.pdf",
  url_private_download:
    "https://files.slack.com/files-pri/T0001-F0001/download/report.pdf",
  permalink: "https://example.slack.com/files/U0001/F0001/report.pdf",
};

describe("slack inbound files", () => {
  it("maps the wire fields to a fetchable Media url", () => {
    const files = normalizeSlackFiles([wireFile, { no_id: true }, null]);
    expect(files).toHaveLength(1);
    expect(files?.[0]).toMatchObject({
      id: "F0001",
      urlPrivate: wireFile.url_private,
      urlPrivateDownload: wireFile.url_private_download,
      mimetype: "application/pdf",
    });
    const media = slackFilesToMedia(files, {
      channelId: "C1",
      messageTs: "1.0",
    });
    expect(media).toEqual([
      {
        id: "F0001",
        url: wireFile.url_private_download,
        title: "report",
        source: "slack",
        description: "report.pdf",
      },
    ]);
  });

  it("falls back to url_private and omits a file with neither url", () => {
    const files = normalizeSlackFiles([
      { ...wireFile, url_private_download: undefined },
      { id: "F0002", name: "ghost.txt" },
    ]);
    const media = slackFilesToMedia(files, {
      channelId: "C1",
      messageTs: "1.0",
    });
    expect(media.map((entry) => [entry.id, entry.url])).toEqual([
      ["F0001", wireFile.url_private],
    ]);
  });

  it("carries the url through the real buildMemoryFromMessage path", async () => {
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as unknown as IAgentRuntime;
    const service = Object.create(SlackService.prototype) as SlackService;
    Object.assign(service, {
      runtime,
      defaultAccountId: "default",
      getRoomId: vi.fn(async () => "00000000-0000-0000-0000-00000000000a"),
      getUser: vi.fn(async () => null),
      getTeamIdForAccount: vi.fn(() => "T0001"),
    });
    const memory = (await (
      service as unknown as {
        buildMemoryFromMessage(
          event: unknown,
          accountId?: string,
        ): Promise<Memory | null>;
      }
    ).buildMemoryFromMessage({
      type: "message",
      subtype: "file_share",
      channel: "C1",
      channel_type: "channel",
      user: "U0001",
      text: "here is the report",
      ts: "1700000000.000100",
      files: [wireFile],
    })) as Memory;
    expect(memory.content.attachments).toEqual([
      expect.objectContaining({
        id: "F0001",
        url: wireFile.url_private_download,
        source: "slack",
      }),
    ]);
  });
});
