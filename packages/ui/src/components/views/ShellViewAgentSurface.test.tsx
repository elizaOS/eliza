/** Verifies ShellViewAgentSurface through the package's configured test harness. */
// @vitest-environment jsdom
//
// ShellViewAgentSurface: a wrapped shell page answers list-elements / agent-click
// through the WS interact dispatch, and reports an error for an unsupported
// capability. The `client` WS transport is mocked; the surface + registry are real.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTACTS_VIEW_CAPABILITIES } from "../../../../../plugins/plugin-contacts/src/view-capabilities";
import { MESSAGES_VIEW_CAPABILITIES } from "../../../../../plugins/plugin-messages/src/view-capabilities";
import { PHONE_VIEW_CAPABILITIES } from "../../../../../plugins/plugin-phone/src/view-capabilities";

const sendWsMessage = vi.fn();
vi.mock("../../api", () => ({ client: { sendWsMessage } }));

afterEach(cleanup);
beforeEach(() => sendWsMessage.mockClear());

const { ShellViewAgentSurface } = await import("./ShellViewAgentSurface");
const { AgentButton } = await import("../../agent-surface");
const { dispatchViewInteract } = await import("./view-interact-registry");

describe("ShellViewAgentSurface", () => {
  it.each([
    ["contacts", "list-contacts", CONTACTS_VIEW_CAPABILITIES],
    ["messages", "list-threads", MESSAGES_VIEW_CAPABILITIES],
    ["phone", "phone-state", PHONE_VIEW_CAPABILITIES],
  ] as const)(
    "routes the bundled %s read while rejecting its human-only and generic operations",
    async (viewId, read, capabilities) => {
      const records = [{ id: "last-record", text: "complete native result" }];
      const interact = vi.fn(async () => records);
      const onClick = vi.fn();
      render(
        <ShellViewAgentSurface
          viewId={viewId}
          capabilities={capabilities}
          interact={interact}
          surface={{ capabilities: [] }}
        >
          <AgentButton agentId="send" onClick={onClick}>
            Send
          </AgentButton>
        </ShellViewAgentSurface>,
      );
      await dispatchViewInteract(
        viewId,
        "gui",
        read,
        undefined,
        `${viewId}-native-read`,
      );
      expect(sendWsMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          requestId: `${viewId}-native-read`,
          success: true,
          result: records,
        }),
      );
      for (const capability of [
        ...capabilities
          .filter((entry) => entry.authority === "human")
          .map((entry) => entry.id),
        "agent-click",
        "click-element",
      ]) {
        await dispatchViewInteract(
          viewId,
          "gui",
          capability,
          { id: "send" },
          `${viewId}-denied-${capability}`,
        );
        expect(sendWsMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({
            requestId: `${viewId}-denied-${capability}`,
            success: false,
          }),
        );
      }
      expect(interact).toHaveBeenCalledOnce();
      expect(onClick).not.toHaveBeenCalled();
    },
  );
  it("makes a wrapped shell page controllable via the interact dispatch", async () => {
    const { ShellViewAgentSurface } = await import("./ShellViewAgentSurface");
    const { AgentButton } = await import("../../agent-surface");
    const { dispatchViewInteract } = await import("./view-interact-registry");

    const onClick = vi.fn();
    const rendered = render(
      <ShellViewAgentSurface viewId="settings">
        <AgentButton agentId="save" onClick={onClick}>
          Save
        </AgentButton>
      </ShellViewAgentSurface>,
    );

    expect(
      rendered.container.querySelector(
        '[data-agent-surface-view-id="settings"][data-agent-surface-kind="builtin"]',
      ),
    ).not.toBeNull();

    // list-elements through the WS interact dispatch returns the registered button.
    await dispatchViewInteract(
      "settings",
      "gui",
      "list-elements",
      undefined,
      "r1",
    );
    const listMsg = sendWsMessage.mock.calls.at(-1)?.[0];
    expect(listMsg).toMatchObject({
      type: "view:interact:result",
      requestId: "r1",
      success: true,
    });
    expect(
      (listMsg.result as Array<{ id: string }>).map((e) => e.id),
    ).toContain("save");

    // agent-click drives the page's handler.
    await dispatchViewInteract(
      "settings",
      "gui",
      "agent-click",
      { id: "save" },
      "r2",
    );
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("reports an error for an unsupported capability", async () => {
    const { ShellViewAgentSurface } = await import("./ShellViewAgentSurface");
    const { dispatchViewInteract } = await import("./view-interact-registry");
    render(
      <ShellViewAgentSurface viewId="character">
        <div>character</div>
      </ShellViewAgentSurface>,
    );
    await dispatchViewInteract(
      "character",
      "gui",
      "no-such-cap",
      undefined,
      "r3",
    );
    const msg = sendWsMessage.mock.calls.at(-1)?.[0];
    expect(msg).toMatchObject({ requestId: "r3", success: false });
    expect(String(msg.error)).toContain("does not support capability");
  });
});
