// @vitest-environment jsdom

import type { ModelOption } from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { client, type FirstRunOptions } from "../../api";
import {
  ProviderRoutingPanel,
  type ProviderRoutingPanelProps,
} from "./ProviderRoutingPanel";
import type { CloudModelSchema } from "./cloud-model-schema";
import { useCloudModelConfig } from "./useCloudModelConfig";

// The per-task override grid is a `ConfigRenderer` (a JSONSchema-driven
// collaborator). Stub it so we can (a) assert the panel forwards the derived
// per-tier `modelValues` into it and (b) assert its `onChange` is wired to
// `onModelFieldChange` — without booting the full schema renderer. Everything
// else (the primary Radix Select, the routing hook, the shared payload
// builders) is the real thing.
vi.mock("../../components/config-ui/config-renderer", () => ({
  ConfigRenderer: (props: {
    values: Record<string, unknown>;
    setKeys: Set<string>;
    onChange: (key: string, value: unknown) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-config-renderer"
      data-values={JSON.stringify(props.values)}
      data-setkeys={JSON.stringify([...props.setKeys].sort())}
      onClick={() => props.onChange("responseHandler", "claude-opus-4-7")}
    >
      overrides
    </button>
  ),
}));

// Radix Select drives open/close through pointer capture and scrolls the active
// item into view; jsdom implements neither. Keyboard activation is the
// deterministic path.
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LARGE_OPTIONS: ModelOption[] = [
  { id: "zai-glm-4.7", name: "GLM 4.7", provider: "zai", description: "d" },
  {
    id: "anthropic/claude",
    name: "Claude",
    provider: "anthropic",
    description: "d",
  },
  // id intentionally unlike its display label — catches label/value swaps.
  { id: "x/grok:variant", name: "Grok", provider: "xai", description: "d" },
];

// In test mode the app store's `t` is an identity function returning the key,
// so the primary select's accessible name is the raw i18n key.
const PRIMARY_MODEL_LABEL = "providerswitcher.model";

function baseProps(
  over: Partial<ProviderRoutingPanelProps> = {},
): ProviderRoutingPanelProps {
  return {
    largeModelOptions: LARGE_OPTIONS,
    cloudModelSchema: null,
    modelValues: { values: {}, setKeys: new Set<string>() },
    currentLargeModel: "zai-glm-4.7",
    modelSaving: false,
    modelSaveSuccess: false,
    onModelFieldChange: () => {},
    showCloudControls: true,
    elizaCloudConnected: true,
    ...over,
  };
}

async function pickPrimaryModel(optionName: string) {
  const trigger = screen.getByLabelText(PRIMARY_MODEL_LABEL);
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.click(option);
}

describe("ProviderRoutingPanel — gating", () => {
  it("renders nothing when cloud is not the active route", () => {
    const { container } = render(
      <ProviderRoutingPanel {...baseProps({ showCloudControls: false })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when Eliza Cloud is not connected", () => {
    const { container } = render(
      <ProviderRoutingPanel {...baseProps({ elizaCloudConnected: false })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there are no models and no schema", () => {
    const { container } = render(
      <ProviderRoutingPanel
        {...baseProps({ largeModelOptions: [], cloudModelSchema: null })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("ProviderRoutingPanel — primary model selection", () => {
  it("fires the setter with the tier key and the exact model id", async () => {
    const onModelFieldChange = vi.fn();
    render(<ProviderRoutingPanel {...baseProps({ onModelFieldChange })} />);

    await pickPrimaryModel("Claude");

    expect(onModelFieldChange).toHaveBeenCalledTimes(1);
    expect(onModelFieldChange).toHaveBeenCalledWith("large", "anthropic/claude");
  });

  it("persists the model id, never the display label", async () => {
    const onModelFieldChange = vi.fn();
    render(<ProviderRoutingPanel {...baseProps({ onModelFieldChange })} />);

    await pickPrimaryModel("Grok");

    expect(onModelFieldChange).toHaveBeenCalledWith("large", "x/grok:variant");
    // Regression guard: a label/value swap would send "Grok".
    expect(onModelFieldChange).not.toHaveBeenCalledWith("large", "Grok");
  });

  it("keeps the key stable across successive switches and is idempotent on re-select", async () => {
    const calls: Array<[string, unknown]> = [];

    function Controlled() {
      const [large, setLarge] = useState("zai-glm-4.7");
      return (
        <ProviderRoutingPanel
          {...baseProps({
            currentLargeModel: large,
            onModelFieldChange: (key, value) => {
              calls.push([key, value]);
              if (key === "large") setLarge(String(value));
            },
          })}
        />
      );
    }

    render(<Controlled />);

    await pickPrimaryModel("Claude");
    // Re-selecting the already-active model must NOT re-fire (no redundant
    // config write + agent restart).
    await pickPrimaryModel("Claude");
    await pickPrimaryModel("Grok");

    expect(calls).toEqual([
      ["large", "anthropic/claude"],
      ["large", "x/grok:variant"],
    ]);
  });
});

describe("ProviderRoutingPanel — per-task override wiring", () => {
  it("forwards derived per-tier values into the overrides grid and routes its changes back", () => {
    const onModelFieldChange = vi.fn();
    const schema: CloudModelSchema = {
      schema: { type: "object", properties: {} },
      hints: {},
    };
    render(
      <ProviderRoutingPanel
        {...baseProps({
          cloudModelSchema: schema,
          modelValues: {
            values: { large: "zai-glm-4.7", responseHandler: "seed-rh" },
            setKeys: new Set(["large", "responseHandler"]),
          },
          onModelFieldChange,
        })}
      />,
    );

    const grid = screen.getByTestId("mock-config-renderer");
    // The overrides UI reads the same derived state the panel holds — one
    // source of truth for the routing choice.
    expect(JSON.parse(grid.getAttribute("data-values") ?? "{}")).toEqual({
      large: "zai-glm-4.7",
      responseHandler: "seed-rh",
    });
    expect(JSON.parse(grid.getAttribute("data-setkeys") ?? "[]")).toEqual([
      "large",
      "responseHandler",
    ]);

    fireEvent.click(grid);
    expect(onModelFieldChange).toHaveBeenCalledWith(
      "responseHandler",
      "claude-opus-4-7",
    );
  });
});

describe("ProviderRoutingPanel — save status", () => {
  it("shows a saving indicator while a routing write is in flight", () => {
    render(<ProviderRoutingPanel {...baseProps({ modelSaving: true })} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("shows a success indicator after a routing write lands", () => {
    render(<ProviderRoutingPanel {...baseProps({ modelSaveSuccess: true })} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("shows no status indicator at rest", () => {
    render(<ProviderRoutingPanel {...baseProps()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

// Integration: the real routing hook wired to the panel exactly as CloudPanel
// wires it. Only the config API transport (the collaborator we don't drive) is
// mocked; the payload is composed by the real shared builders.
function CloudHarness() {
  const cfg = useCloudModelConfig(() => {});
  useEffect(() => {
    cfg.setModelOptions({
      nano: [],
      small: [],
      medium: [],
      large: LARGE_OPTIONS,
      mega: [],
    } satisfies FirstRunOptions["models"]);
    cfg.initializeFromConfig(
      {
        models: {
          nano: "n0",
          small: "s0",
          medium: "m0",
          large: "zai-glm-4.7",
          mega: "x0",
        },
      },
      true,
    );
    // Stable useCallbacks; run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ProviderRoutingPanel
      largeModelOptions={cfg.largeModelOptions}
      cloudModelSchema={cfg.cloudModelSchema}
      modelValues={cfg.modelValues}
      currentLargeModel={cfg.currentLargeModel}
      modelSaving={cfg.modelSaving}
      modelSaveSuccess={cfg.modelSaveSuccess}
      onModelFieldChange={cfg.handleModelFieldChange}
      showCloudControls
      elizaCloudConnected
    />
  );
}

describe("ProviderRoutingPanel — routing persistence (integration)", () => {
  it("writes the routing payload through the config API and restarts the agent", async () => {
    const getConfig = vi
      .spyOn(client, "getConfig")
      .mockResolvedValue({ serviceRouting: {} } as never);
    const updateConfig = vi
      .spyOn(client, "updateConfig")
      .mockResolvedValue(undefined as never);
    const restartAgent = vi
      .spyOn(client, "restartAgent")
      .mockResolvedValue(undefined as never);

    render(<CloudHarness />);
    // Options populate after the mount effect resolves.
    await screen.findByLabelText(PRIMARY_MODEL_LABEL);

    await pickPrimaryModel("Grok");

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));

    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        models: expect.objectContaining({
          large: "x/grok:variant",
          // untouched tiers are preserved from the loaded config
          small: "s0",
          nano: "n0",
        }),
        serviceRouting: expect.objectContaining({
          llmText: expect.objectContaining({
            largeModel: "x/grok:variant",
            backend: "elizacloud",
            transport: "cloud-proxy",
          }),
        }),
      }),
    );
    await waitFor(() => expect(restartAgent).toHaveBeenCalledTimes(1));
  });
});
