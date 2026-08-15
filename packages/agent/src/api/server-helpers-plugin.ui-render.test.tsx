/**
 * Renders the actual plugin-config reply through the shared UiRenderer and
 * verifies its live-state save action at the agent/UI package boundary.
 * Deterministic jsdom integration; only the final action callback is mocked.
 */
// @vitest-environment jsdom

import type { UiSpec } from "@elizaos/shared";
import { UiRenderer } from "@elizaos/ui/components/config-ui";
import { __setAppValueForTests } from "@elizaos/ui/state/app-store";
import { AppContext } from "@elizaos/ui/state/useApp";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePluginConfigReply } from "./server-helpers-plugin.ts";

function parseForm(reply: string): UiSpec {
  const match = reply.match(/```json-render\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error(
      `expected json-render form fence, got: ${reply.slice(0, 200)}`,
    );
  }
  return JSON.parse(match[1]) as UiSpec;
}

describe("resolvePluginConfigReply UiRenderer integration", () => {
  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
  });

  it("renders the emitted Discord fields and dispatches their edited state", async () => {
    const reply = await resolvePluginConfigReply("configure discord", {
      config: {},
      runtime: null,
    } as never);
    if (typeof reply !== "string") {
      throw new Error("expected configure discord to return a form string");
    }

    const onAction = vi.fn();
    const appValue = {
      t: (key: string, vars?: Record<string, unknown>) =>
        String(vars?.defaultValue ?? key),
    } as never;
    __setAppValueForTests(appValue);
    const { container } = render(
      <AppContext.Provider value={appValue}>
        <UiRenderer spec={parseForm(reply)} onAction={onAction} />
      </AppContext.Provider>,
    );

    const inputs = container.querySelectorAll("input");
    expect(inputs).toHaveLength(5);
    fireEvent.change(inputs[0] as HTMLInputElement, {
      target: { value: "live-token" },
    });
    fireEvent.change(inputs[3] as HTMLInputElement, {
      target: { value: "allowlist" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(onAction).toHaveBeenCalledWith(
      "plugin:save",
      {
        pluginId: "discord",
        "config.DISCORD_API_TOKEN": "live-token",
        "config.DISCORD_APPLICATION_ID": "",
        "config.ELIZA_DISCORD_OWNER_USER_IDS_JSON": "",
        "config.DISCORD_DM_POLICY": "allowlist",
        "config.DISCORD_ALLOW_FROM": "",
      },
      {
        historySafeParams: {
          pluginId: "discord",
          "config.DISCORD_APPLICATION_ID": "",
          "config.ELIZA_DISCORD_OWNER_USER_IDS_JSON": "",
          "config.DISCORD_DM_POLICY": "allowlist",
          "config.DISCORD_ALLOW_FROM": "",
        },
      },
    );
  });
});
