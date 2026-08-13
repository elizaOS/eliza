/**
 * Exercises UiSpec plugin actions through the real renderer and chat action
 * boundary while replacing only the outbound HTTP client.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiSpec } from "../../config/ui-spec";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";
import { UiRenderer } from "../config-ui";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    updatePlugin: vi.fn(),
  },
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

import { MessageUiSpecBlock } from "./MessageContent";

function withApp(node: React.ReactElement) {
  const sendActionMessage = vi.fn();
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    sendActionMessage,
  } as never;
  __setAppValueForTests(appValue);
  return {
    ...render(
      <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
    ),
    sendActionMessage,
  };
}

function pluginConfigSpec(): UiSpec {
  return {
    version: 1,
    root: "root",
    state: {
      pluginId: "discord",
      "config.DISCORD_API_TOKEN": "",
      "config.DISCORD_APPLICATION_ID": "",
    },
    elements: {
      root: {
        type: "Stack",
        props: {},
        children: ["token", "application", "save"],
      },
      token: {
        type: "Input",
        props: {
          label: "Bot Token",
          statePath: "config.DISCORD_API_TOKEN",
          type: "password",
        },
        children: [],
      },
      application: {
        type: "Input",
        props: {
          label: "Application ID",
          statePath: "config.DISCORD_APPLICATION_ID",
        },
        children: [],
      },
      save: {
        type: "Button",
        props: { label: "Save configuration" },
        children: [],
        on: {
          press: {
            action: "plugin:save",
            params: {
              pluginId: "discord",
              "config.DISCORD_API_TOKEN": {
                $path: "config.DISCORD_API_TOKEN",
              },
              "config.DISCORD_APPLICATION_ID": {
                $path: "config.DISCORD_APPLICATION_ID",
              },
            },
          },
        },
      },
    },
  } as UiSpec;
}

describe("MessageUiSpecBlock plugin actions", () => {
  beforeEach(() => {
    clientMock.updatePlugin.mockReset();
  });

  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
  });

  it("sends edited UiSpec state as the plugin config patch", async () => {
    clientMock.updatePlugin.mockResolvedValue({ ok: true });
    const spec = pluginConfigSpec();
    const { container, sendActionMessage } = withApp(
      <MessageUiSpecBlock spec={spec} raw={JSON.stringify(spec)} />,
    );
    const inputs = container.querySelectorAll("input");
    expect(inputs).toHaveLength(2);

    fireEvent.change(inputs[0] as HTMLInputElement, {
      target: { value: "token-value" },
    });
    fireEvent.change(inputs[1] as HTMLInputElement, {
      target: { value: "application-id-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    await waitFor(() => {
      expect(clientMock.updatePlugin).toHaveBeenCalledWith("discord", {
        config: {
          DISCORD_API_TOKEN: "token-value",
          DISCORD_APPLICATION_ID: "application-id-value",
        },
      });
    });
    expect(sendActionMessage).toHaveBeenCalledWith(
      "[Plugin discord configuration saved successfully]",
    );
  });

  it("rejects a plugin config save with no entered values", async () => {
    const spec = pluginConfigSpec();
    const { sendActionMessage } = withApp(
      <MessageUiSpecBlock spec={spec} raw={JSON.stringify(spec)} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    await waitFor(() => {
      expect(sendActionMessage).toHaveBeenCalledWith(
        "[Failed to save plugin config: no configuration values were provided]",
      );
    });
    expect(clientMock.updatePlugin).not.toHaveBeenCalled();
    expect(sendActionMessage).not.toHaveBeenCalledWith(
      "[Plugin discord configuration saved successfully]",
    );
  });

  it("omits untouched empty fields from a partial config save", async () => {
    clientMock.updatePlugin.mockResolvedValue({ ok: true });
    const spec = pluginConfigSpec();
    const { container } = withApp(
      <MessageUiSpecBlock spec={spec} raw={JSON.stringify(spec)} />,
    );

    const inputs = container.querySelectorAll("input");
    fireEvent.change(inputs[0] as HTMLInputElement, {
      target: { value: "token-only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    await waitFor(() => {
      expect(clientMock.updatePlugin).toHaveBeenCalledWith("discord", {
        config: { DISCORD_API_TOKEN: "token-only" },
      });
    });
  });

  it("resolves documented action bindings without rewriting literal path payloads", async () => {
    const spec = pluginConfigSpec();
    spec.state.dynamicValue = "live-value";
    spec.elements.save.on = {
      press: {
        action: "inspect",
        params: {
          fromPath: { $path: "dynamicValue" },
          fromData: "$data.dynamicValue",
          literalTarget: { path: "/literal/target" },
        },
      },
    };
    const onAction = vi.fn();
    withApp(<UiRenderer spec={spec} onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith("inspect", {
        fromPath: "live-value",
        fromData: "live-value",
        literalTarget: { path: "/literal/target" },
      });
    });
  });

  it("rejects malformed action bindings through the declared error action", async () => {
    const spec = pluginConfigSpec();
    spec.elements.save.on = {
      press: {
        action: "inspect",
        params: { invalid: { $path: 42 } },
        onError: { action: "invalid-binding" },
      },
    };
    const { sendActionMessage } = withApp(
      <MessageUiSpecBlock spec={spec} raw={JSON.stringify(spec)} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    await waitFor(() => {
      expect(sendActionMessage).toHaveBeenCalledWith(
        "[action:invalid-binding]",
      );
      expect(sendActionMessage).not.toHaveBeenCalledWith(
        expect.stringContaining("[action:inspect]"),
      );
    });
  });

  it("surfaces malformed action bindings when no error action is declared", async () => {
    const spec = pluginConfigSpec();
    spec.elements.save.on = {
      press: {
        action: "inspect",
        params: { invalid: { $path: 42 } },
      },
    };
    const { sendActionMessage } = withApp(
      <MessageUiSpecBlock spec={spec} raw={JSON.stringify(spec)} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    const alert = await screen.findByRole("alert", {
      name: "Interactive action unavailable",
    });
    expect(alert.textContent).toContain(
      "This action is unavailable because its dynamic parameters are invalid.",
    );
    expect(sendActionMessage).not.toHaveBeenCalled();
  });

  it("preserves generic non-secret params without serializing password state", async () => {
    const spec = pluginConfigSpec();
    spec.state.amount = 0.25;
    spec.elements.save.on = {
      press: {
        action: "sendBnb",
        params: {
          amount: { $path: "amount" },
          address: "$data.config.DISCORD_APPLICATION_ID",
          network: "bsc",
          token: { $path: "config.DISCORD_API_TOKEN" },
        },
      },
    };
    const { container, sendActionMessage } = withApp(
      <MessageUiSpecBlock spec={spec} raw={JSON.stringify(spec)} />,
    );

    const secretValue = "entered-secret-value";
    const inputs = container.querySelectorAll("input");
    fireEvent.change(inputs[0] as HTMLInputElement, {
      target: { value: secretValue },
    });
    fireEvent.change(inputs[1] as HTMLInputElement, {
      target: { value: "0xrecipient" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    await waitFor(() => {
      expect(sendActionMessage).toHaveBeenCalledWith(
        '[action:sendBnb] {"amount":0.25,"address":"0xrecipient","network":"bsc"}',
      );
    });
    expect(sendActionMessage).not.toHaveBeenCalledWith(
      expect.stringContaining(secretValue),
    );
  });

  it("redacts a secret-declared field that is not a password input", async () => {
    // A seed phrase in a Textarea, or a text Input labelled "Private key",
    // cannot use `type: "password"`. Declaring `secret` must keep it out of
    // durable chat history just as a password input does.
    const spec = pluginConfigSpec();
    spec.elements.application.props = {
      label: "Recovery phrase",
      statePath: "config.DISCORD_APPLICATION_ID",
      secret: true,
    };
    spec.elements.save.on = {
      press: {
        action: "sendBnb",
        params: {
          network: "bsc",
          phrase: { $path: "config.DISCORD_APPLICATION_ID" },
        },
      },
    };
    const { container, sendActionMessage } = withApp(
      <MessageUiSpecBlock spec={spec} raw={JSON.stringify(spec)} />,
    );

    const secretValue = "correct horse battery staple";
    fireEvent.change(
      container.querySelectorAll("input")[1] as HTMLInputElement,
      { target: { value: secretValue } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    await waitFor(() => {
      expect(sendActionMessage).toHaveBeenCalledWith(
        '[action:sendBnb] {"network":"bsc"}',
      );
    });
    expect(sendActionMessage).not.toHaveBeenCalledWith(
      expect.stringContaining(secretValue),
    );
  });

  it("rejects plugin saves without an id without serializing config state", async () => {
    const spec = pluginConfigSpec();
    spec.elements.save.on = {
      press: {
        action: "plugin:save",
        params: {
          "config.DISCORD_API_TOKEN": {
            $path: "config.DISCORD_API_TOKEN",
          },
        },
      },
    };
    const { container, sendActionMessage } = withApp(
      <MessageUiSpecBlock spec={spec} raw={JSON.stringify(spec)} />,
    );

    const secretValue = "malformed-save-secret";
    fireEvent.change(
      container.querySelectorAll("input")[0] as HTMLInputElement,
      {
        target: { value: secretValue },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    await waitFor(() => {
      expect(sendActionMessage).toHaveBeenCalledWith(
        "[Failed to save plugin config: pluginId is required]",
      );
    });
    expect(clientMock.updatePlugin).not.toHaveBeenCalled();
    expect(sendActionMessage).not.toHaveBeenCalledWith(
      expect.stringContaining(secretValue),
    );
  });
});
