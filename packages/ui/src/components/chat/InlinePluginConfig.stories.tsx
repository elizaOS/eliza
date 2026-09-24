/**
 * Storybook states for the in-chat connector-setup widget (#14412): the
 * `[CONFIG:<pluginId>]` card (InlinePluginConfig) inside its standardized
 * ChatWidgetShell. Three canonical states: fresh setup (expanded, minimal
 * fields only), advanced-expanded (the optional params revealed behind the
 * Advanced disclosure), and connected-collapsed (compact status row with the
 * chevron re-expand affordance).
 *
 * Self-contained mocking: InlinePluginConfig fetches `/api/plugins` through
 * the ElizaClient's global-fetch transport, so each story installs a
 * window.fetch answering that route with a Telegram-shaped connector fixture.
 */

import type { PluginParamDef } from "@elizaos/shared";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { PluginInfo } from "../../api/client-types-config";
import { assert, waitForTestId } from "../../storybook/home-widget-decorator";
import { MockAppProvider } from "../../storybook/mock-providers";
import { InlinePluginConfig } from "./MessageContent";

function param(
  over: Partial<PluginParamDef> & { key: string },
): PluginParamDef {
  return {
    type: "string",
    description: "",
    required: false,
    sensitive: false,
    currentValue: null,
    isSet: false,
    ...over,
  };
}

function telegram(over: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "telegram",
    name: "Telegram",
    description: "Telegram bot connector",
    enabled: false,
    configured: false,
    envKey: null,
    category: "connector",
    source: "bundled",
    icon: "\u{1F4AC}",
    parameters: [
      param({
        key: "TELEGRAM_BOT_TOKEN",
        description: "Bot token from @BotFather",
        required: true,
        sensitive: true,
      }),
      param({ key: "TELEGRAM_API_ROOT", description: "API root override" }),
      param({
        key: "TELEGRAM_ALLOWED_CHATS",
        description: "Comma-separated chat allowlist",
      }),
    ],
    validationErrors: [],
    validationWarnings: [],
    ...over,
  };
}

/** Install a window.fetch that answers `/api/plugins` with the fixture. */
function withPlugins(plugin: PluginInfo): Decorator {
  return (Story) => {
    const originalFetch = window.fetch;
    window.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const body = url.includes("/api/plugins") ? { plugins: [plugin] } : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof window.fetch;
    // Delayed restore (not queueMicrotask) so the widget's mount fetch and the
    // play-function interactions resolve against the mock; each story renders
    // in its own iframe so this cannot leak across stories.
    setTimeout(() => {
      window.fetch = originalFetch;
    }, 4_000);
    return (
      <MockAppProvider>
        <div className="max-w-xl">
          <Story />
        </div>
      </MockAppProvider>
    );
  };
}

const meta = {
  title: "Chat/ConnectorSetupWidget",
  component: InlinePluginConfig,
  parameters: { layout: "padded" },
  args: { pluginId: "telegram" },
} satisfies Meta<typeof InlinePluginConfig>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Fresh setup: unconfigured connector mounts EXPANDED with only the required
 * (minimal) field visible; the optional params sit behind the closed Advanced
 * disclosure.
 */
export const FreshSetup: Story = {
  decorators: [withPlugins(telegram())],
  play: async ({ canvasElement }) => {
    const chevron = await waitForTestId(
      canvasElement,
      "inline-plugin-config-chevron",
    );
    assert(
      chevron.getAttribute("aria-expanded") === "true",
      "fresh setup starts expanded",
    );
    assert(
      canvasElement.querySelector(
        'input[data-config-key="TELEGRAM_BOT_TOKEN"]',
      ) !== null,
      "required token field is in the minimal set",
    );
    assert(
      canvasElement.querySelector(
        'input[data-config-key="TELEGRAM_API_ROOT"]',
      ) === null,
      "optional field stays behind the Advanced disclosure",
    );
  },
};

/** Advanced disclosure open: the optional params are revealed below the fold. */
export const AdvancedExpanded: Story = {
  decorators: [withPlugins(telegram())],
  play: async ({ canvasElement }) => {
    await waitForTestId(canvasElement, "inline-plugin-config-body");
    const advancedToggle = Array.from(
      canvasElement.querySelectorAll("button"),
    ).find((b) => b.textContent?.includes("Advanced"));
    assert(advancedToggle, "the Advanced disclosure toggle renders");
    advancedToggle.click();
    const revealed = await new Promise<Element | null>((resolve) => {
      setTimeout(
        () =>
          resolve(
            canvasElement.querySelector(
              'input[data-config-key="TELEGRAM_API_ROOT"]',
            ),
          ),
        100,
      );
    });
    assert(revealed !== null, "optional fields render once Advanced is open");
  },
};

/**
 * Connected: enabled + configured connector mounts COLLAPSED to the compact
 * status row ("Telegram is enabled.") with the chevron as the re-expand
 * affordance; the body stays mounted but costs no layout.
 */
export const ConnectedCollapsed: Story = {
  decorators: [withPlugins(telegram({ enabled: true, configured: true }))],
  play: async ({ canvasElement }) => {
    const summary = await waitForTestId(
      canvasElement,
      "inline-plugin-config-summary",
    );
    assert(
      summary.textContent?.includes("Telegram is enabled."),
      "collapsed summary shows the connected status",
    );
    const chevron = await waitForTestId(
      canvasElement,
      "inline-plugin-config-chevron",
    );
    assert(
      chevron.getAttribute("aria-expanded") === "false",
      "connected card is collapsed",
    );
    const body = await waitForTestId(
      canvasElement,
      "inline-plugin-config-body",
    );
    assert(body.style.display === "none", "collapsed body is out of layout");
  },
};
