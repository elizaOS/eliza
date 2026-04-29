import { LifeOpsService } from "@elizaos/app-lifeops/lifeops/service";
import { afterEach, describe, expect, it } from "vitest";
import { createMockedTestRuntime } from "../../../test/mocks/helpers/mock-runtime.ts";

const INTERNAL_URL = new URL("http://127.0.0.1:31337");

describe("LifeOps simulator runtime", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("seeds a mock owner with passive inbound data and verifies bidirectional connector APIs", async () => {
    const mocked = await createMockedTestRuntime({
      seedLifeOpsSimulator: true,
      seedX: false,
    });
    cleanups.push(mocked.cleanup);

    const service = new LifeOpsService(mocked.runtime);
    expect(mocked.simulator?.summary.channelMessages).toBeGreaterThanOrEqual(5);

    const gmail = await service.getGmailTriage(INTERNAL_URL, {
      maxResults: 8,
      forceSync: true,
    });
    expect(gmail.messages.map((message) => message.subject)).toEqual(
      expect.arrayContaining(["Project Atlas request to meet Thursday"])
    );

    await service.sendGmailMessage(INTERNAL_URL, {
      to: ["alice.nguyen@example.test"],
      subject: "Re: Project Atlas request to meet Thursday",
      bodyText: "Mock simulator reply from the owner.",
      confirmSend: true,
    });

    const calendarWindowAnchor = Date.now();
    const calendar = await service.getCalendarFeed(INTERNAL_URL, {
      forceSync: true,
      timeMin: new Date(calendarWindowAnchor - 60 * 60 * 1000).toISOString(),
      timeMax: new Date(
        calendarWindowAnchor + 2 * 24 * 60 * 60 * 1000
      ).toISOString(),
    });
    expect(calendar.events.map((event) => event.title)).toEqual(
      expect.arrayContaining([
        "Project Atlas working session",
        "Investor diligence review",
      ])
    );

    const createdEvent = await service.createCalendarEvent(INTERNAL_URL, {
      title: "Simulator outbound calendar hold",
      startAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      endAt: new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString(),
      timeZone: "America/Los_Angeles",
      attendees: [{ email: "alice.nguyen@example.test" }],
    });
    expect(createdEvent.title).toBe("Simulator outbound calendar hold");

    const telegramStatus = await service.getTelegramConnectorStatus("owner");
    expect(telegramStatus.connected).toBe(true);
    const telegramHits = await service.searchTelegramMessages({
      query: "Project Atlas",
      limit: 5,
    });
    expect(telegramHits.map((hit) => hit.content).join("\n")).toContain(
      "Project Atlas"
    );
    const telegramSend = await service.sendTelegramMessage({
      target: "alice_ops",
      message: "Mock Telegram reply from the simulator.",
    });
    expect(telegramSend.messageId).toBeTruthy();

    const signalMessages = await service.readSignalInbound(10);
    expect(signalMessages.map((message) => message.text).join("\n")).toContain(
      "Signal check"
    );
    const signalSend = await service.sendSignalMessage({
      recipient: "+15551110001",
      text: "Mock Signal reply from the simulator.",
    });
    expect(signalSend.ok).toBe(true);

    const imessages = await service.readIMessages({ limit: 10 });
    expect(imessages.map((message) => message.text).join("\n")).toContain(
      "Project Atlas"
    );
    const imessageSend = await service.sendIMessage({
      to: "+15551112222",
      text: "Mock iMessage reply from the simulator.",
    });
    expect(imessageSend.ok).toBe(true);

    const whatsapp = service.pullWhatsAppRecent(10);
    expect(
      whatsapp.messages.map((message) => message.text ?? "").join("\n")
    ).toContain("WhatsApp ping");
    const whatsappSend = await service.sendWhatsAppMessage({
      to: "+15553338888",
      text: "Mock WhatsApp reply from the simulator.",
    });
    expect(whatsappSend.ok).toBe(true);

    const discordStatus = await service.getDiscordConnectorStatus("owner");
    expect(discordStatus.connected).toBe(true);
    const discordHits = await service.searchDiscordMessages({
      query: "ProjectAtlas",
    });
    expect(discordHits.map((hit) => hit.content).join("\n")).toContain(
      "ProjectAtlas"
    );
    const discordSend = await service.sendDiscordMessage({
      channelId: discordStatus.dmInbox.selectedChannelId ?? undefined,
      text: "Mock Discord reply from the simulator.",
    });
    expect(discordSend.ok).toBe(true);

    const definitions = await service.listDefinitions();
    expect(definitions.map((entry) => entry.definition.title)).toEqual(
      expect.arrayContaining([
        "Review Project Atlas launch checklist",
        "Send diligence packet comments",
      ])
    );

    const ledger = mocked.mocks.requestLedger();
    expect(
      ledger.some((entry) => entry.gmail?.action === "messages.send")
    ).toBe(true);
    expect(
      ledger.some((entry) => entry.calendar?.action === "events.create")
    ).toBe(true);
    expect(ledger.some((entry) => entry.signal?.action === "send")).toBe(true);
    expect(
      ledger.some((entry) => entry.whatsapp?.action === "messages.send")
    ).toBe(true);
    expect(
      ledger.some((entry) => entry.bluebubbles?.action === "message.text")
    ).toBe(true);
    expect(
      ledger.some((entry) => entry.browserWorkspace?.action === "tabs.eval")
    ).toBe(true);
  }, 180_000);
});
