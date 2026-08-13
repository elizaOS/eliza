/**
 * Regression for #18975: plugin config forms must bind each declared config
 * field into the save action via $path references so the UiRenderer resolves
 * live state values at dispatch time. Without this, the save button sends only
 * { pluginId } and the client receives an empty config patch.
 */
import { describe, expect, it } from "vitest";
import { resolvePluginConfigReply } from "./server-helpers-plugin.ts";

type FormSpec = {
  version: number;
  root: string;
  elements: Record<string, { type: string; props?: Record<string, unknown> }>;
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

describe("resolvePluginConfigReply save action binds config fields via $path", () => {
  it("save action params include $path references for every config field", async () => {
    const reply = await resolvePluginConfigReply("configure discord", {
      config: {},
      runtime: null,
    } as never);
    expect(typeof reply).toBe("string");
    if (typeof reply !== "string") return;

    const form = parseForm(reply);

    // Find the save button element
    const saveBtn = form.elements["saveBtn"];
    expect(saveBtn).toBeDefined();
    const onPress = (saveBtn.props?.on as Record<string, unknown>)?.press as {
      action: string;
      params: Record<string, unknown>;
    };
    expect(onPress.action).toBe("plugin:save");
    expect(onPress.params.pluginId).toBe("discord");

    // Every config.* state key declared in the form must have a $path binding
    // in the save action params so UiRenderer resolves it at dispatch time.
    const configStateKeys = Object.keys(form.state).filter((k) =>
      k.startsWith("config."),
    );
    expect(configStateKeys.length).toBeGreaterThan(0);

    for (const stateKey of configStateKeys) {
      const param = onPress.params[stateKey] as { $path?: string } | undefined;
      expect(param).toBeDefined();
      expect(param?.$path).toBe(stateKey);
    }
  });
});
