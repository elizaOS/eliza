/**
 * v629 (Pixel): "show my open tabs" had no operation and the reply said the
 * agent could not list tabs. A whole-message request to see the open tabs now
 * routes to DEVICE_BROWSER_TAB_OVERVIEW, which brings the phone's own tab list
 * to the front; the agent never receives the tabs.
 */
import {
  AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  getDirectActionRoutingRules,
  type Memory,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asksToSeeBrowserTabs } from "./browser-contract.ts";
import {
  DeviceActionService,
  setDeviceActionRequestMessage,
  withDeviceActionTurn,
} from "./service.ts";
import {
  deviceActionTools,
  registerDeviceBrowserTabListRouting,
} from "./tools.ts";

describe("a request to see the open Browser tabs", () => {
  it.each([
    "show my open tabs",
    "Show me my tabs.",
    "list my browser tabs",
    "show all my open tabs",
    "please show the open tabs",
    "Alpha, show my tabs",
    "can you show me my open tabs?",
    "what tabs do I have open?",
    "Which tabs are open",
    "what browser tabs do I have open in the browser",
  ])("is recognized: %s", (text) => {
    expect(asksToSeeBrowserTabs(text, "Alpha")).toBe(true);
  });

  it.each([
    "open a new tab",
    "switch to the example.com tab",
    "close all the browser tabs",
    "show my contacts",
    "show my tabs and close the bbc one",
    "how do tabs work",
    "don't show my tabs",
    "open example.com",
    "show tabs from yesterday's research in a note",
  ])("is not claimed: %s", (text) => {
    expect(asksToSeeBrowserTabs(text, "Alpha")).toBe(false);
  });
});

const owner = "11111111-1111-4111-8111-111111111111";
const runtimes: AgentRuntime[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  runtimes.splice(0);
});

async function routed(
  text: string,
  capabilities: string[],
  source = "client_chat",
): Promise<boolean> {
  const runtime = new AgentRuntime({
    character: {
      name: "Alpha",
      bio: [],
      settings: { ELIZA_ADMIN_ENTITY_ID: owner },
    },
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  vi.spyOn(runtime, "getRoom").mockResolvedValue({ worldId: "world" } as never);
  vi.spyOn(runtime, "getWorld").mockResolvedValue({
    id: "world",
    metadata: { roles: { [owner]: "OWNER" }, ownership: { ownerId: owner } },
  } as never);
  registerDeviceBrowserTabListRouting(runtime);
  const rule = getDirectActionRoutingRules(runtime).find(
    (r) => r.id === "device.browser-tab-list",
  );
  expect(rule?.actionNames).toEqual(["DEVICE_BROWSER_TAB_OVERVIEW"]);
  const tool = deviceActionTools.find(
    (a) => a.name === "DEVICE_BROWSER_TAB_OVERVIEW",
  );
  for (const tag of rule?.requiredActionTags ?? [])
    expect(tool?.tags).toContain(tag);
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId: runtime.agentId,
    entityId: owner,
    roomId: "22222222-2222-4222-8222-222222222222",
    content: { text, source, channelType: "DM" },
  } as Memory;
  vi.spyOn(runtime, "getEntityById").mockResolvedValue(null);
  vi.spyOn(runtime, "getParticipantsForRoom").mockResolvedValue([
    owner,
    runtime.agentId,
  ]);
  await attestAuthenticatedApiDeliveryAudience(runtime, message, {
    kind: "owner_session",
    principalId: "fixture",
  });
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
    null,
  );
  return withDeviceActionTurn(
    runtime,
    {
      subjectUserId: "owner-subject",
      installationId: "installation",
      deviceKey: "device-key",
      capabilities,
    } as never,
    async () => {
      setDeviceActionRequestMessage(runtime, message);
      return rule?.matches(text, message) === true;
    },
    {
      requestCaller: {
        subjectUserId: "owner-subject",
        entityId: owner,
        role: "OWNER",
      },
    },
  );
}

describe("the device.browser-tab-list route", () => {
  it("claims the owner's request on a phone that shows its tab list", async () => {
    expect(
      await routed("show my open tabs", [
        "browser.tabs.v1",
        "browser.tabs.show.v1",
      ]),
    ).toBe(true);
  });

  it("leaves the request to the model on a phone without the tab list", async () => {
    expect(await routed("show my open tabs", ["browser.tabs.v1"])).toBe(false);
  });

  it("claims no request that did not come from the owner's phone chat", async () => {
    expect(
      await routed("show my open tabs", ["browser.tabs.show.v1"], "discord"),
    ).toBe(false);
  });
});
