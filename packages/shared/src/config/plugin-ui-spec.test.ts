/**
 * Unit tests for plugin-ui-spec: validates declarative UI generation for
 * plugin config forms, secret key masking, and connector action buttons.
 */
import { describe, expect, it } from "vitest";
import {
  buildPluginConfigUiSpec,
  type PluginForUiSpec,
} from "./plugin-ui-spec.ts";

describe("plugin-ui-spec", () => {
  it("builds complete UI spec for enabled plugin with parameters", () => {
    const plugin: PluginForUiSpec = {
      id: "plugin-test",
      name: "Test Plugin",
      description: "A test plugin description",
      enabled: true,
      category: "tools",
      parameters: [
        {
          key: "API_KEY",
          label: "API Key",
          required: true,
          isSet: true,
          description: "Your service API Key",
        },
        {
          key: "ENDPOINT",
          label: "Custom Endpoint",
          required: false,
          isSet: false,
        },
      ],
    };

    const spec = buildPluginConfigUiSpec(plugin);

    expect(spec.version).toBe(1);
    expect(spec.root).toBe("root");
    expect(spec.elements.title.props.text).toBe("Configure Test Plugin");
    expect(spec.elements.desc.props.text).toBe("A test plugin description");
    expect(spec.elements.status.props.text).toBe("Ready");

    // Check password masking for API_KEY
    const fieldApiKey = spec.elements.field_API_KEY;
    expect(fieldApiKey.props.type).toBe("password");
    expect(fieldApiKey.validation).toBeDefined();

    // Check normal text for ENDPOINT
    const fieldEndpoint = spec.elements.field_ENDPOINT;
    expect(fieldEndpoint.props.type).toBe("text");

    // Check buttons
    expect(spec.elements.saveBtn).toBeDefined();
    expect(spec.elements.enableBtn).toBeUndefined(); // already enabled
    expect(spec.elements.testBtn).toBeUndefined(); // category !== connector
  });

  it("includes enable button when plugin is disabled and test button for connector", () => {
    const connectorPlugin: PluginForUiSpec = {
      id: "plugin-discord",
      name: "Discord",
      enabled: false,
      category: "connector",
      parameters: [{ key: "DISCORD_TOKEN", required: true, isSet: false }],
    };

    const spec = buildPluginConfigUiSpec(connectorPlugin);
    expect(spec.elements.status.props.text).toBe("Disabled");
    expect(spec.elements.enableBtn).toBeDefined();
    expect(spec.elements.testBtn).toBeDefined();
  });
});
