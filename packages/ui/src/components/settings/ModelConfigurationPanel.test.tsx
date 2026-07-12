// @vitest-environment jsdom

/**
 * Covers the per-role model configuration panel: catalog-driven option
 * filtering per provider/backend, the chat restart-confirm save flow (with
 * the server-side restart poll — never a client restartAgent call), the
 * restart-free coding save, and inline rendering of the route's typed 400 /
 * 409 outcomes. jsdom render with the app store, API client, and agent
 * surface mocked; selects are driven through their agent-surface onFill
 * bindings (the production chat-control path).
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelCatalog,
  ModelsConfigResponse,
} from "../../api/client-types-core";

interface CapturedAgentElement {
  id: string;
  options?: string[];
  onFill?: (value: string) => void;
  onActivate?: () => void;
}

const { clientMock, agentElements } = vi.hoisted(() => ({
  clientMock: {
    getModelsCatalog: vi.fn(),
    getModelsConfig: vi.fn(),
    updateModelsConfig: vi.fn(),
    getStatus: vi.fn(),
    restartAgent: vi.fn(),
  },
  agentElements: new Map<
    string,
    {
      options?: string[];
      onFill?: (v: string) => void;
      onActivate?: () => void;
    }
  >(),
}));

vi.mock("../../state", () => {
  const t = (key: string, vars?: Record<string, unknown>) => {
    const template =
      typeof vars?.defaultValue === "string" ? vars.defaultValue : key;
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
      String(vars?.[name] ?? ""),
    );
  };
  return {
    useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
      sel({ t }),
    useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
      sel({ t }),
  };
});

vi.mock("../../api", () => ({ client: clientMock }));

vi.mock("../../agent-surface", () => ({
  useAgentElement: (spec: CapturedAgentElement) => {
    agentElements.set(spec.id, {
      options: spec.options,
      onFill: spec.onFill,
      onActivate: spec.onActivate,
    });
    return { ref: undefined, agentProps: { "data-agent-id": spec.id } };
  },
}));

import { ModelConfigurationPanel } from "./ModelConfigurationPanel";

function fixtureCatalog(): ModelCatalog {
  return {
    providers: {
      codex: [
        {
          id: "gpt-5.6-terra",
          display: "GPT-5.6-Terra",
          efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
          defaultEffort: "medium",
          roles: ["coding"],
          costHint: "highest cost/latency tier",
        },
        {
          id: "gpt-5.3-codex-spark",
          display: "GPT-5.3-Codex-Spark",
          efforts: ["low", "medium", "high", "xhigh"],
          defaultEffort: "high",
          roles: ["coding"],
          apiSupported: false,
        },
      ],
      "claude-chat": [
        {
          id: "claude-opus-4-8",
          display: "Claude Opus 4.8",
          efforts: ["low", "medium", "high", "xhigh", "max"],
          roles: ["small", "large"],
        },
      ],
      "claude-coding": [
        {
          id: "claude-opus-4-8",
          display: "Claude Opus 4.8",
          efforts: ["low", "medium", "high", "xhigh", "max"],
          defaultEffort: "xhigh",
          roles: ["coding"],
        },
      ],
      cerebras: [
        {
          id: "gemma-4-31b",
          display: "Gemma 4 31B",
          efforts: ["low", "medium", "high"],
          roles: ["small"],
        },
        {
          id: "zai-glm-4.7",
          display: "GLM-4.7",
          efforts: ["low", "medium", "high"],
          roles: ["small", "large"],
        },
        {
          id: "plain-model",
          display: "Plain Model",
          efforts: [],
          roles: ["small", "large"],
        },
      ],
      elizacloud: [
        {
          id: "gpt-oss-120b",
          display: "GPT-OSS 120B",
          efforts: ["low", "medium", "high"],
          roles: ["small", "large"],
        },
      ],
    },
  };
}

function fixtureConfig(): ModelsConfigResponse {
  return {
    targets: {
      small: {
        OPENAI_SMALL_MODEL: { value: "gemma-4-31b", source: "process.env" },
        ANTHROPIC_SMALL_MODEL: null,
        OPENAI_REASONING_EFFORT: { value: "low", source: "config.env" },
        ANTHROPIC_EFFORT_SMALL: null,
      },
      large: {
        OPENAI_LARGE_MODEL: { value: "zai-glm-4.7", source: "config.env" },
        ANTHROPIC_LARGE_MODEL: null,
        OPENAI_REASONING_EFFORT: { value: "low", source: "config.env" },
        ANTHROPIC_EFFORT_LARGE: null,
      },
      coding: {
        ELIZA_DEFAULT_AGENT_TYPE: { value: "codex", source: "config.env" },
        ELIZA_CODEX_MODEL_POWERFUL: {
          value: "gpt-5.6-terra",
          source: "default",
        },
        ELIZA_CODEX_EFFORT: { value: "medium", source: "config.env" },
        ELIZA_CLAUDE_MODEL_POWERFUL: null,
        ELIZA_CLAUDE_EFFORT: null,
        ELIZA_OPENCODE_MODEL_POWERFUL: {
          value: "custom-oss-model",
          source: "config.env",
        },
        ELIZA_ELIZAOS_MODEL_POWERFUL: null,
      },
    },
  };
}

function fill(agentId: string, value: string) {
  const element = agentElements.get(agentId);
  if (!element?.onFill) throw new Error(`no onFill captured for ${agentId}`);
  act(() => element.onFill?.(value));
}

function agentButton(agentId: string): HTMLButtonElement {
  const node = document.querySelector(`button[data-agent-id="${agentId}"]`);
  if (!node) throw new Error(`no button rendered for ${agentId}`);
  return node as HTMLButtonElement;
}

async function renderReady() {
  render(<ModelConfigurationPanel />);
  await waitFor(() =>
    expect(agentElements.has("models-small-provider")).toBe(true),
  );
}

beforeEach(() => {
  agentElements.clear();
  clientMock.getModelsCatalog.mockReset();
  clientMock.getModelsCatalog.mockResolvedValue({
    providers: {},
    catalog: fixtureCatalog(),
  });
  clientMock.getModelsConfig.mockReset();
  clientMock.getModelsConfig.mockResolvedValue(fixtureConfig());
  clientMock.updateModelsConfig.mockReset();
  clientMock.getStatus.mockReset();
  clientMock.getStatus.mockResolvedValue({ state: "running" });
  clientMock.restartAgent.mockReset();
});

afterEach(() => cleanup());

describe("catalog load states", () => {
  it("renders a loading state while the catalog fetch is pending", async () => {
    let resolveCatalog: (value: unknown) => void = () => {};
    clientMock.getModelsCatalog.mockReturnValue(
      new Promise((resolve) => {
        resolveCatalog = resolve;
      }),
    );
    render(<ModelConfigurationPanel />);
    expect(screen.getByText("Loading model catalog…")).toBeTruthy();
    await act(async () => {
      resolveCatalog({ providers: {}, catalog: fixtureCatalog() });
    });
  });

  it("renders the error state with retry when the fetch fails, and recovers", async () => {
    clientMock.getModelsCatalog.mockRejectedValueOnce(
      new Error("catalog unreachable"),
    );
    render(<ModelConfigurationPanel />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("catalog unreachable");

    agentButton("models-retry").click();
    await waitFor(() =>
      expect(agentElements.has("models-small-provider")).toBe(true),
    );
  });

  it("renders a readable error for a runtime that predates the model-config API", async () => {
    // An older runtime (or a shapeless stub) answers without the catalog /
    // targets fields — the boundary guard must surface the designed error
    // state, never a TypeError from draft resolution.
    clientMock.getModelsCatalog.mockResolvedValue({});
    clientMock.getModelsConfig.mockResolvedValue({});
    render(<ModelConfigurationPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "did not return a model catalog (/api/models)",
    );
  });

  it("renders the designed empty state for an empty catalog", async () => {
    clientMock.getModelsCatalog.mockResolvedValue({
      providers: {},
      catalog: { providers: { codex: [], cerebras: [] } },
    });
    render(<ModelConfigurationPanel />);
    expect(
      await screen.findByText(
        "No configurable models were reported by the runtime.",
      ),
    ).toBeTruthy();
  });
});

describe("prefill and option filtering", () => {
  it("prefills groups from the effective config and surfaces the env source", async () => {
    await renderReady();

    expect(agentElements.get("models-small-provider")?.options).toEqual([
      "cerebras",
      "elizacloud",
      "claude-chat",
    ]);
    // Small target: only cerebras entries whose roles include "small".
    expect(agentElements.get("models-small-model")?.options).toEqual([
      "gemma-4-31b",
      "zai-glm-4.7",
      "plain-model",
    ]);
    expect(screen.getByText("Set by environment")).toBeTruthy();
    // Prefilled efforts come from the shared/openai knob.
    expect(agentElements.get("models-small-effort")?.options).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("re-filters model options when the provider changes", async () => {
    await renderReady();

    fill("models-small-provider", "claude-chat");
    expect(agentElements.get("models-small-model")?.options).toEqual([
      "claude-opus-4-8",
    ]);
    // No model selected yet → no effort row.
    expect(
      document.querySelector('[data-agent-id="models-small-effort"]'),
    ).toBeNull();

    fill("models-small-model", "claude-opus-4-8");
    expect(agentElements.get("models-small-effort")?.options).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("hides the effort control for models without an effort knob", async () => {
    await renderReady();

    fill("models-small-model", "plain-model");
    expect(
      document.querySelector('[data-agent-id="models-small-effort"]'),
    ).toBeNull();
  });

  it("clamps codex efforts to the acp-parseable set and keeps the coding prefill", async () => {
    await renderReady();

    expect(agentElements.get("models-coding-model")?.options).toEqual([
      "gpt-5.6-terra",
      "gpt-5.3-codex-spark",
    ]);
    expect(agentElements.get("models-coding-effort")?.options).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("keeps a configured opencode model visible even when not in the suggestion list", async () => {
    await renderReady();

    fill("models-coding-backend", "opencode");
    expect(agentElements.get("models-coding-model")?.options).toEqual([
      "custom-oss-model",
      "gemma-4-31b",
      "zai-glm-4.7",
      "plain-model",
    ]);
    expect(
      document.querySelector('[data-agent-id="models-coding-effort"]'),
    ).toBeNull();
  });

  it("renders a free-form model input for the eliza-code backend", async () => {
    await renderReady();

    fill("models-coding-backend", "eliza-code");
    const input = document.querySelector(
      'input[data-agent-id="models-coding-model"]',
    );
    expect(input).toBeTruthy();
  });
});

describe("active-provider scoping", () => {
  it("pins the chat provider to the active intelligence selection and scopes models to it", async () => {
    render(<ModelConfigurationPanel activeChatProvider="elizacloud" />);
    await waitFor(() =>
      expect(agentElements.has("models-small-model")).toBe(true),
    );

    // No free provider dropdown — the provider follows the active selection.
    expect(agentElements.has("models-small-provider")).toBe(false);
    expect(
      document.querySelector('[data-agent-id="models-small-provider"]'),
    ).toBeNull();
    expect(
      screen.getAllByText(/follows your active provider/i).length,
    ).toBeGreaterThan(0);

    // Model options come from the pinned provider's slice only.
    const options = agentElements.get("models-small-model")?.options ?? [];
    for (const id of options) {
      expect(
        fixtureCatalog().providers.elizacloud?.some((m) => m.id === id),
      ).toBe(true);
    }
  });

  it("keeps the free provider choice when no active provider maps to the catalog", async () => {
    render(<ModelConfigurationPanel />);
    await waitFor(() =>
      expect(agentElements.has("models-small-provider")).toBe(true),
    );
    expect(agentElements.has("models-small-provider")).toBe(true);
  });

  it("saves against the pinned provider", async () => {
    clientMock.updateModelsConfig.mockResolvedValue({
      kind: "applied",
      restart: true,
      keys: ["OPENAI_SMALL_MODEL"],
      operationId: "op-1",
    });
    render(<ModelConfigurationPanel activeChatProvider="cerebras" />);
    await waitFor(() =>
      expect(agentElements.has("models-small-model")).toBe(true),
    );
    fill("models-small-model", "gemma-4-31b");
    act(() => agentButton("models-small-save").click());
    await waitFor(() =>
      expect(agentElements.has("models-small-confirm-restart")).toBe(true),
    );
    act(() => agentButton("models-small-confirm-restart").click());
    await waitFor(() =>
      expect(clientMock.updateModelsConfig).toHaveBeenCalled(),
    );
    expect(clientMock.updateModelsConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "small",
        provider: "cerebras",
        model: "gemma-4-31b",
      }),
    );
  });
});

describe("chat save flow", () => {
  it("requires an explicit restart confirmation before posting, then polls status", async () => {
    clientMock.updateModelsConfig.mockResolvedValue({
      kind: "applied",
      restart: true,
      operationId: "op-1",
      keys: ["OPENAI_SMALL_MODEL", "OPENAI_REASONING_EFFORT"],
    });
    let resolveStatus: (value: unknown) => void = () => {};
    clientMock.getStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    await renderReady();

    act(() => agentButton("models-small-save").click());
    expect(screen.getByText("Restart to apply?")).toBeTruthy();
    expect(clientMock.updateModelsConfig).not.toHaveBeenCalled();

    act(() => agentButton("models-small-confirm-restart").click());
    await waitFor(() =>
      expect(clientMock.updateModelsConfig).toHaveBeenCalledWith({
        target: "small",
        provider: "cerebras",
        model: "gemma-4-31b",
        effort: "low",
      }),
    );

    // The route restarts server-side; the panel polls status but must never
    // trigger a second restart itself.
    expect(await screen.findByText("Restarting agent…")).toBeTruthy();
    expect(clientMock.restartAgent).not.toHaveBeenCalled();

    await act(async () => {
      resolveStatus({ state: "running" });
    });
    expect(await screen.findByText("Saved")).toBeTruthy();
    // Source notes refresh from the server after a successful write.
    expect(clientMock.getModelsConfig).toHaveBeenCalledTimes(2);
  });

  it("cancels an armed restart confirmation without posting", async () => {
    await renderReady();

    act(() => agentButton("models-small-save").click());
    act(() => agentButton("models-small-cancel").click());

    expect(screen.queryByText("Restart to apply?")).toBeNull();
    expect(clientMock.updateModelsConfig).not.toHaveBeenCalled();
  });

  it("renders the route's typed 400 inline with the supported values", async () => {
    clientMock.updateModelsConfig.mockResolvedValue({
      kind: "invalid",
      error: 'Effort "ultra" is not supported by model "gemma-4-31b"',
      supported: ["low", "medium", "high"],
    });
    await renderReady();

    act(() => agentButton("models-small-save").click());
    act(() => agentButton("models-small-confirm-restart").click());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain('Effort "ultra" is not supported');
    expect(alert.textContent).toContain("Supported: low, medium, high");
  });

  it("surfaces an in-flight runtime operation (409) inline", async () => {
    clientMock.updateModelsConfig.mockResolvedValue({
      kind: "busy",
      error: "A runtime operation is already in progress",
      activeOperationId: "op-9",
    });
    await renderReady();

    act(() => agentButton("models-large-save").click());
    act(() => agentButton("models-large-confirm-restart").click());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "A runtime operation is already in progress (operation op-9)",
    );
  });
});

describe("coding save flow", () => {
  it("saves without confirmation or restart and shows the no-restart copy", async () => {
    clientMock.updateModelsConfig.mockResolvedValue({
      kind: "applied",
      restart: false,
      keys: ["ELIZA_CODEX_MODEL_POWERFUL", "ELIZA_CODEX_EFFORT"],
    });
    await renderReady();

    act(() => agentButton("models-coding-save").click());
    await waitFor(() =>
      expect(clientMock.updateModelsConfig).toHaveBeenCalledWith({
        target: "coding",
        backend: "codex",
        model: "gpt-5.6-terra",
        effort: "medium",
        // codex is the persisted ELIZA_DEFAULT_AGENT_TYPE, so the default
        // switch is prefilled on.
        defaultBackend: "codex",
      }),
    );

    expect(
      await screen.findByText("Saved — applies to the next coding task"),
    ).toBeTruthy();
    expect(clientMock.getStatus).not.toHaveBeenCalled();
    expect(clientMock.restartAgent).not.toHaveBeenCalled();
  });

  it("posts the eliza-code wire value with a free-form model and no effort", async () => {
    clientMock.updateModelsConfig.mockResolvedValue({
      kind: "applied",
      restart: false,
      keys: ["ELIZA_ELIZAOS_MODEL_POWERFUL"],
    });
    await renderReady();

    fill("models-coding-backend", "eliza-code");
    fill("models-coding-model", "my-house-model");
    act(() => agentButton("models-coding-save").click());

    await waitFor(() =>
      expect(clientMock.updateModelsConfig).toHaveBeenCalledWith({
        target: "coding",
        backend: "eliza-code",
        model: "my-house-model",
      }),
    );
  });
});
