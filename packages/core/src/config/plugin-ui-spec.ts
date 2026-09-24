/**
 * Generates UiSpec JSON for plugin/connector configuration forms.
 *
 * When the agent wants to help a user configure a plugin, it generates
 * a UiSpec that renders as an interactive form in chat. The form fields
 * are derived from the plugin's parameter definitions.
 *
 * Actions:
 *   - "plugin:save" → saves config via PUT /api/plugins/:id
 *   - "plugin:enable" → enables the plugin
 *   - "plugin:test" → tests connectivity
 */

export interface PluginParam {
  key: string;
  required?: boolean;
  isSet?: boolean;
  type?: string;
  description?: string;
  label?: string;
}

export interface PluginForUiSpec {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  category?: string;
  parameters: PluginParam[];
}

/** Declarative UI specification for rendering plugin forms in chat. */
export interface PluginUiSpec {
  version: number;
  root: string;
  elements: Record<string, Record<string, unknown>>;
  state: Record<string, unknown>;
}

export function buildPluginConfigUiSpec(plugin: PluginForUiSpec): PluginUiSpec {
  const elements: Record<string, Record<string, unknown>> = {};
  const rootChildren: string[] = [];
  const state: Record<string, unknown> = {
    pluginId: plugin.id,
  };

  // Header
  elements.header = {
    type: "Stack",
    props: { gap: "1", children: ["title", "desc"] },
  };
  rootChildren.push("header");

  elements.title = {
    type: "Heading",
    props: {
      level: 3,
      text: `Configure ${plugin.name}`,
    },
  };

  if (plugin.description) {
    elements.desc = {
      type: "Text",
      props: {
        text: plugin.description,
        className: "text-xs text-muted",
      },
    };
  }

  // Status badge
  const statusText = plugin.enabled
    ? plugin.parameters.every((p) => !p.required || p.isSet)
      ? "Ready"
      : "Needs Configuration"
    : "Disabled";
  const statusVariant = plugin.enabled
    ? plugin.parameters.every((p) => !p.required || p.isSet)
      ? "default"
      : "secondary"
    : "outline";
  elements.status = {
    type: "Badge",
    props: { text: statusText, variant: statusVariant },
  };
  rootChildren.push("status");

  // Separator
  elements.sep = { type: "Separator", props: {} };
  rootChildren.push("sep");

  // Parameter fields
  const fieldIds: string[] = [];
  for (const param of plugin.parameters) {
    const fieldId = `field_${param.key}`;
    const statePath = `config.${param.key}`;
    fieldIds.push(fieldId);
    state[`config.${param.key}`] = "";

    const isSecret =
      param.key.includes("KEY") ||
      param.key.includes("TOKEN") ||
      param.key.includes("SECRET") ||
      param.key.includes("PASSWORD");

    elements[fieldId] = {
      type: "Input",
      props: {
        label: param.label || param.key,
        placeholder: param.isSet
          ? "••••••• (already set)"
          : param.required
            ? "Required"
            : "Optional",
        statePath,
        type: isSecret ? "password" : "text",
        className: "font-mono text-xs",
      },
      ...(param.required
        ? {
            validation: {
              checks: [
                { rule: "required", message: `${param.key} is required` },
              ],
            },
          }
        : {}),
    };

    // Add description below field if available
    if (param.description) {
      const hintId = `hint_${param.key}`;
      fieldIds.push(hintId);
      elements[hintId] = {
        type: "Text",
        props: {
          text: param.description,
          className: "text-2xs text-muted -mt-1 mb-1",
        },
      };
    }
  }

  elements.fields = {
    type: "Stack",
    props: { gap: "3", children: fieldIds },
  };
  rootChildren.push("fields");

  // Action buttons
  const buttonChildren = ["saveBtn"];
  elements.saveBtn = {
    type: "Button",
    props: {
      text: "Save Configuration",
      variant: "default",
      className: "font-semibold",
      on: {
        press: {
          action: "plugin:save",
          params: { pluginId: plugin.id },
        },
      },
    },
  };

  if (!plugin.enabled) {
    buttonChildren.push("enableBtn");
    elements.enableBtn = {
      type: "Button",
      props: {
        text: "Enable Plugin",
        variant: "outline",
        on: {
          press: {
            action: "plugin:enable",
            params: { pluginId: plugin.id },
          },
        },
      },
    };
  }

  if (plugin.category === "connector") {
    buttonChildren.push("testBtn");
    elements.testBtn = {
      type: "Button",
      props: {
        text: "Test Connection",
        variant: "outline",
        on: {
          press: {
            action: "plugin:test",
            params: { pluginId: plugin.id },
          },
        },
      },
    };
  }

  elements.actions = {
    type: "Stack",
    props: { direction: "row", gap: "2", children: buttonChildren },
  };
  rootChildren.push("actions");

  // Root
  elements.root = {
    type: "Card",
    props: {
      children: rootChildren,
      className: "p-4 space-y-3",
    },
  };

  return {
    version: 1,
    root: "root",
    elements,
    state,
  };
}

/**
 * Generate a compact plugin list UiSpec for the agent to show available
 * plugins matching a query.
 */
export function buildPluginListUiSpec(
  plugins: PluginForUiSpec[],
  title: string,
): PluginUiSpec {
  const elements: Record<string, Record<string, unknown>> = {};
  const cardIds: string[] = [];

  elements.heading = {
    type: "Heading",
    props: { level: 3, text: title },
  };

  for (let i = 0; i < plugins.length; i++) {
    const p = plugins[i];
    const cardId = `card_${i}`;
    const nameId = `name_${i}`;
    const descId = `desc_${i}`;
    const badgeId = `badge_${i}`;
    const configBtnId = `cfgBtn_${i}`;
    cardIds.push(cardId);

    elements[nameId] = {
      type: "Text",
      props: {
        text: p.name,
        className: "font-semibold text-sm",
      },
    };
    elements[descId] = {
      type: "Text",
      props: {
        text: p.description || "No description",
        className: "text-xs text-muted",
      },
    };
    elements[badgeId] = {
      type: "Badge",
      props: {
        text: p.enabled ? "Enabled" : "Available",
        variant: p.enabled ? "default" : "outline",
      },
    };
    elements[configBtnId] = {
      type: "Button",
      props: {
        text: "Configure",
        variant: "outline",
        size: "sm",
        on: {
          press: {
            action: "plugin:configure",
            params: { pluginId: p.id },
          },
        },
      },
    };

    elements[cardId] = {
      type: "Card",
      props: {
        children: [nameId, descId, badgeId, configBtnId],
        className: "p-3 space-y-1",
      },
    };
  }

  elements.list = {
    type: "Stack",
    props: { gap: "2", children: cardIds },
  };

  elements.root = {
    type: "Stack",
    props: { gap: "3", children: ["heading", "list"] },
  };

  return {
    version: 1,
    root: "root",
    elements,
    state: {},
  };
}
