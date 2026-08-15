/**
 * Unit tests for the Discord plugin chat-config form parameters emitted by
 * resolvePluginConfigReply. Ensures owner user IDs, DM policy, and allowlist
 * fields appear alongside bot token / application ID. Deterministic.
 */
import { describe, expect, it } from "vitest";
import { resolvePluginConfigReply } from "./server-helpers-plugin.ts";

type FormSpec = {
  version: number;
  root: string;
  elements: Record<
    string,
    {
      type: string;
      props?: Record<string, unknown>;
      children: string[];
      on?: {
        press?: { action: string; params?: Record<string, unknown> };
      };
    }
  >;
  state: Record<string, string>;
};

function parseForm(reply: string): FormSpec {
  const match = reply.match(/```json-render\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error(
      `expected json-render form fence, got: ${reply.slice(0, 200)}`,
    );
  }
  return JSON.parse(match[1]) as FormSpec;
}

describe("resolvePluginConfigReply discord ownership fields", () => {
  it("includes owner, DM policy, and allowlist inputs on configure discord", async () => {
    const reply = await resolvePluginConfigReply("configure discord", {
      config: {},
      runtime: null,
    } as never);
    expect(typeof reply).toBe("string");
    if (typeof reply !== "string") {
      throw new Error("expected configure discord to return a form string");
    }
    const form = parseForm(reply);

    expect(form.state.pluginId).toBe("discord");
    expect(form.state["config.DISCORD_API_TOKEN"]).toBe("");
    expect(form.state["config.DISCORD_APPLICATION_ID"]).toBe("");
    expect(form.state["config.ELIZA_DISCORD_OWNER_USER_IDS_JSON"]).toBe("");
    expect(form.state["config.DISCORD_DM_POLICY"]).toBe("");
    expect(form.state["config.DISCORD_ALLOW_FROM"]).toBe("");

    const labels = Object.values(form.elements)
      .filter((el) => el.type === "Input")
      .map((el) => String(el.props?.label ?? ""));

    expect(labels).toEqual(
      expect.arrayContaining([
        "Bot Token",
        "Application ID (optional, auto-resolved when omitted)",
        'Owner Discord user IDs (JSON array, e.g. ["123456789012345678"])',
        "DM policy (open | allowlist | pairing | disabled)",
        "DM allowlist (comma-separated Discord user IDs)",
      ]),
    );

    expect(form.elements.root?.children).toEqual([
      "title",
      "sep",
      "fields",
      "actions",
    ]);
    expect(form.elements.fields?.children).toEqual([
      "f_DISCORD_API_TOKEN",
      "f_DISCORD_APPLICATION_ID",
      "f_ELIZA_DISCORD_OWNER_USER_IDS_JSON",
      "f_DISCORD_DM_POLICY",
      "f_DISCORD_ALLOW_FROM",
    ]);
    expect(form.elements.actions?.children).toEqual(["saveBtn"]);
    for (const element of Object.values(form.elements)) {
      expect(Array.isArray(element.children)).toBe(true);
      expect(element.props).not.toHaveProperty("children");
    }

    const save = Object.values(form.elements).find(
      (element) => element.type === "Button",
    );
    expect(save?.props?.label).toBe("Save configuration");
    expect(save?.on?.press).toEqual({
      action: "plugin:save",
      params: {
        pluginId: "discord",
        "config.DISCORD_API_TOKEN": {
          $path: "config.DISCORD_API_TOKEN",
        },
        "config.DISCORD_APPLICATION_ID": {
          $path: "config.DISCORD_APPLICATION_ID",
        },
        "config.ELIZA_DISCORD_OWNER_USER_IDS_JSON": {
          $path: "config.ELIZA_DISCORD_OWNER_USER_IDS_JSON",
        },
        "config.DISCORD_DM_POLICY": {
          $path: "config.DISCORD_DM_POLICY",
        },
        "config.DISCORD_ALLOW_FROM": {
          $path: "config.DISCORD_ALLOW_FROM",
        },
      },
    });
  });

  it("returns null for prompts that are not plugin config intents", async () => {
    const reply = await resolvePluginConfigReply("what is the weather", {
      config: {},
      runtime: null,
    } as never);
    expect(reply).toBeNull();
  });
});
