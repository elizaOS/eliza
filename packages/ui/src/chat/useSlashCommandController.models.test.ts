// @vitest-environment jsdom

/**
 * Model-catalog wiring for useSlashCommandController's "models" choice source:
 * the catalog is fetched only when a loaded command declares a "models"
 * dynamic arg, resolveChoices("models", ctx) answers per subcommand position
 * once it lands, describeChoice labels the values, and a failed fetch degrades
 * to no completions (logged, never a fake list) without polluting the command
 * catalog's error state.
 */

import type { CustomActionDef } from "@elizaos/shared";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlashCommandCatalogItem } from "../api/client-types-commands";
import { ApiError, type ModelCatalogResponse } from "../api/client-types-core";

const { listCommands, listCustomActions, getModelsCatalog } = vi.hoisted(
  () => ({
    listCommands:
      vi.fn<(surface?: string) => Promise<SlashCommandCatalogItem[]>>(),
    listCustomActions: vi.fn<() => Promise<CustomActionDef[]>>(),
    getModelsCatalog: vi.fn<() => Promise<ModelCatalogResponse>>(),
  }),
);

vi.mock("../api", () => ({
  client: {
    listCommands: (surface?: string) => listCommands(surface),
    listCustomActions: () => listCustomActions(),
    getModelsCatalog: () => getModelsCatalog(),
  },
}));
vi.mock("../config/boot-config-react.hooks", () => ({
  useBootConfig: (): { shortcutFlags?: { naturalLanguage?: boolean } } => ({}),
}));
vi.mock("../hooks/useAvailableViews", () => ({
  useAvailableViews: (): { views: never[] } => ({ views: [] }),
}));
vi.mock("../state", () => ({
  useAppSelectorShallow: <T>(
    selector: (state: {
      setTab: (tab: string) => void;
      handleChatClear: () => Promise<void>;
    }) => T,
  ): T =>
    selector({
      setTab: () => {},
      handleChatClear: async () => {},
    }),
}));

import { useSlashCommandController } from "./useSlashCommandController";

function cmd(
  partial: Partial<SlashCommandCatalogItem> & { key: string },
): SlashCommandCatalogItem {
  return {
    nativeName: partial.key,
    description: "",
    textAliases: [`/${partial.key}`],
    scope: "both",
    acceptsArgs: false,
    args: [],
    requiresAuth: false,
    requiresElevated: false,
    target: { kind: "agent" },
    ...partial,
    source: partial.source ?? "builtin",
  };
}

const MODEL_COMMAND = cmd({
  key: "model",
  acceptsArgs: true,
  args: [
    {
      name: "target",
      description: "small, large, coding, show, local, cloud",
      choices: ["small", "large", "coding", "show", "local", "cloud"],
      dynamicChoices: "models",
    },
    { name: "model", description: "model id", dynamicChoices: "models" },
  ],
});

const CATALOG_RESPONSE: ModelCatalogResponse = {
  catalog: {
    providers: {
      codex: [
        {
          id: "gpt-5.5",
          display: "GPT-5.5",
          efforts: ["low", "medium", "high", "xhigh"],
          roles: ["coding"],
        },
      ],
      cerebras: [
        {
          id: "zai-glm-4.7",
          display: "GLM-4.7",
          efforts: ["low", "medium", "high"],
          roles: ["small", "large"],
        },
      ],
    },
  },
};

function apiError(status: number, message: string): ApiError {
  return new ApiError({
    kind: "http",
    path: "/api/models",
    status,
    message,
  });
}

beforeEach(() => {
  listCommands.mockReset();
  listCustomActions.mockReset();
  getModelsCatalog.mockReset();
  listCustomActions.mockResolvedValue([]);
  window.localStorage.clear();
});

describe("useSlashCommandController — models choice source", () => {
  it("fetches the catalog when a command declares a models arg and resolves per-position choices", async () => {
    listCommands.mockResolvedValue([MODEL_COMMAND]);
    getModelsCatalog.mockResolvedValue(CATALOG_RESPONSE);

    const { result } = renderHook(() => useSlashCommandController());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getModelsCatalog).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        result.current.resolveChoices("models", {
          commandKey: "model",
          argIndex: 1,
          precedingTokens: ["large"],
        }),
      ).toEqual(["zai-glm-4.7"]),
    );
    expect(
      result.current.resolveChoices("models", {
        commandKey: "model",
        argIndex: 1,
        precedingTokens: ["coding"],
      }),
    ).toEqual(["codex", "claude", "opencode", "elizaos"]);
    expect(
      result.current.resolveChoices("models", {
        commandKey: "model",
        argIndex: 2,
        precedingTokens: ["coding", "codex"],
      }),
    ).toEqual(["gpt-5.5"]);
  });

  it("labels model values and /model target tokens via describeChoice", async () => {
    listCommands.mockResolvedValue([MODEL_COMMAND]);
    getModelsCatalog.mockResolvedValue(CATALOG_RESPONSE);

    const { result } = renderHook(() => useSlashCommandController());

    await waitFor(() =>
      expect(result.current.describeChoice("models", "zai-glm-4.7")).toBe(
        "GLM-4.7",
      ),
    );
    expect(result.current.describeChoice("models", "coding")).toBe(
      "coding sub-agent model (global)",
    );
    // Non-models sources stay label-free.
    expect(result.current.describeChoice("views", "zai-glm-4.7")).toBe("");
  });

  it("does not fetch the catalog when no command declares a models arg", async () => {
    listCommands.mockResolvedValue([cmd({ key: "help" })]);

    const { result } = renderHook(() => useSlashCommandController());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getModelsCatalog).not.toHaveBeenCalled();
    expect(
      result.current.resolveChoices("models", {
        commandKey: "model",
        argIndex: 1,
        precedingTokens: ["large"],
      }),
    ).toEqual([]);
  });

  it("degrades to no completions on a failed catalog fetch, logged, without flagging the command catalog", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    listCommands.mockResolvedValue([MODEL_COMMAND]);
    const failure = new Error("models route down");
    getModelsCatalog.mockRejectedValue(failure);

    const { result } = renderHook(() => useSlashCommandController());

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("model catalog"),
        failure,
      ),
    );
    expect(
      result.current.resolveChoices("models", {
        commandKey: "model",
        argIndex: 1,
        precedingTokens: ["large"],
      }),
    ).toEqual([]);
    // The command catalog itself loaded fine — no false error state (#12784).
    expect(result.current.error).toBe(false);
    consoleError.mockRestore();
  });

  it("treats an unauthenticated catalog fetch as quietly unavailable (#14663)", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    listCommands.mockResolvedValue([MODEL_COMMAND]);
    getModelsCatalog.mockRejectedValue(apiError(401, "Unauthorized"));

    const { result } = renderHook(() => useSlashCommandController());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getModelsCatalog).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
    expect(
      result.current.resolveChoices("models", {
        commandKey: "model",
        argIndex: 0,
        precedingTokens: [],
      }),
    ).toEqual([]);
    consoleError.mockRestore();
  });
});
