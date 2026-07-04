/**
 * Tests the local signal-cli polling client: env-var config parsing and
 * inbound-envelope mapping, driven against a stubbed global `fetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSignalInboundMessages, readSignalLocalClientConfigFromEnv } from "./local-client";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Signal local client", () => {
  it("reads config from Signal env vars", () => {
    expect(
      readSignalLocalClientConfigFromEnv({
        SIGNAL_ACCOUNT_NUMBER: " +15551234567 ",
        SIGNAL_HTTP_URL: " http://signal.test ",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      accountNumber: "+15551234567",
      httpUrl: "http://signal.test",
    });

    expect(readSignalLocalClientConfigFromEnv({} as NodeJS.ProcessEnv)).toBe(null);
  });

  it("normalizes signal-cli receive payloads into recent messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            envelope: {
              sourceNumber: "+15557654321",
              sourceName: "Ari",
              timestamp: 1780000000000,
              dataMessage: {
                timestamp: 1780000001000,
                message: "  can you review this?  ",
              },
            },
          },
          {
            envelope: {
              sourceNumber: "+15550000000",
              dataMessage: {
                message: "from owner",
                groupInfo: { groupId: "group-1", type: "DELIVER" },
              },
            },
          },
          {
            envelope: {
              sourceNumber: "+15557654321",
              dataMessage: { message: "   " },
            },
          },
        ],
      }))
    );

    const messages = await readSignalInboundMessages({
      accountNumber: "+15550000000",
      httpUrl: "http://signal.test/",
    });

    expect(fetch).toHaveBeenCalledWith("http://signal.test/v1/receive/%2B15550000000", {
      headers: { Accept: "application/json" },
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      roomId: "signal:+15557654321",
      channelId: "+15557654321",
      roomName: "Ari",
      speakerName: "Ari",
      text: "can you review this?",
      createdAt: 1780000001000,
      isFromAgent: false,
      isGroup: false,
    });
    expect(messages[1]).toMatchObject({
      roomId: "signal:group-1",
      channelId: "group-1",
      roomName: "Signal group group-1",
      isFromAgent: true,
      isGroup: true,
    });
  });

  it("ignores malformed receive entries and clamps zero limits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          null,
          1,
          { envelope: null },
          { envelope: [] },
          {
            envelope: {
              sourceNumber: "+15557654321",
              dataMessage: null,
            },
          },
          {
            envelope: {
              sourceNumber: "+15557654321",
              dataMessage: { message: "   " },
            },
          },
          {
            envelope: {
              sourceNumber: "+15557654321",
              dataMessage: { message: "kept" },
            },
          },
          {
            envelope: {
              sourceNumber: "+15550000001",
              dataMessage: { message: "over limit" },
            },
          },
        ],
      }))
    );

    await expect(
      readSignalInboundMessages(
        {
          accountNumber: "+15550000000",
          httpUrl: "http://signal.test/",
        },
        0
      )
    ).resolves.toEqual([
      expect.objectContaining({
        channelId: "+15557654321",
        text: "kept",
      }),
    ]);
  });

  it("uses the default receive cap for non-finite limits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () =>
          Array.from({ length: 26 }, (_, index) => ({
            envelope: {
              sourceNumber: `+155500000${String(index).padStart(2, "0")}`,
              dataMessage: { timestamp: 1780000000000 + index, message: `message ${index}` },
            },
          })),
      }))
    );

    const messages = await readSignalInboundMessages(
      {
        accountNumber: "+15550000000",
        httpUrl: "http://signal.test/",
      },
      Number.NaN
    );

    expect(messages).toHaveLength(25);
    expect(messages.at(-1)?.text).toBe("message 24");
  });

  it("surfaces local receive service failures and non-array payloads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ envelope: {} }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readSignalInboundMessages({
        accountNumber: "+15550000000",
        httpUrl: "http://signal.test",
      })
    ).rejects.toThrow("Signal local receive failed with HTTP 502");
    await expect(
      readSignalInboundMessages({
        accountNumber: "+15550000000",
        httpUrl: "http://signal.test",
      })
    ).rejects.toThrow("Signal local receive returned an unexpected payload");
  });
});
