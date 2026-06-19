// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendWsMessage = vi.fn();
vi.mock("../../api", () => ({ client: { sendWsMessage } }));

afterEach(cleanup);
beforeEach(() => sendWsMessage.mockClear());

describe("ShellViewAgentSurface", () => {
  it("makes a wrapped shell page controllable via the interact dispatch", async () => {
    const { ShellViewAgentSurface } = await import("./ShellViewAgentSurface");
    const { AgentButton } = await import("../../agent-surface");
    const { dispatchViewInteract } = await import("./view-interact-registry");

    const onClick = vi.fn();
    render(
      <ShellViewAgentSurface viewId="settings">
        <AgentButton agentId="save" onClick={onClick}>
          Save
        </AgentButton>
      </ShellViewAgentSurface>,
    );

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
