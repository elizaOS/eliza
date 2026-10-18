/**
 * "text Alex Chen" resolves the name through the connector's resolveTargets.
 * The Contacts map is loaded lazily; an outbound name lookup must load it too,
 * not only the first inbound message. Real IMessageService methods; the
 * macOS Contacts reader is replaced because it needs CNContactStore.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

const loadContacts = vi.fn(async () => new Map([["+14155550199", { name: "Alex Chen" }]]));

vi.mock("../src/contacts-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/contacts-reader.js")>()),
  loadContacts,
  getLastContactsFailure: () => null,
}));

const { IMessageService } = await import("../src/service.js");

type MessageConnectorRegistration = Parameters<IAgentRuntime["registerMessageConnector"]>[0];
type ResolveContext = Parameters<NonNullable<MessageConnectorRegistration["resolveTargets"]>>[1];

describe("iMessage name lookup before any inbound message", () => {
  it("loads the address book once and resolves the contact", async () => {
    const registrations: MessageConnectorRegistration[] = [];
    const runtime = {
      agentId: "agent-1" as UUID,
      registerMessageConnector: vi.fn((registration: MessageConnectorRegistration) => {
        registrations.push(registration);
      }),
      registerSendHandler: vi.fn(),
      getService: vi.fn(() => null),
    } as unknown as IAgentRuntime;
    // Constructed but not started: no inbound message has been dispatched.
    const service = new IMessageService(runtime) as InstanceType<typeof IMessageService> & {
      settings: { transport: string };
    };
    service.settings = { transport: "native" };

    IMessageService.registerSendHandlers(runtime, service);
    const registration = registrations[0];
    const context = { runtime, source: "imessage" } as unknown as ResolveContext;

    const [first, second] = await Promise.all([
      registration.resolveTargets?.("Alex Chen", context),
      registration.resolveTargets?.("Alex", context),
    ]);

    expect(first?.map((target) => target.label)).toContain("Alex Chen (+14155550199)");
    expect(second?.map((target) => target.label)).toContain("Alex Chen (+14155550199)");
    expect(loadContacts).toHaveBeenCalledTimes(1);
  });
});
