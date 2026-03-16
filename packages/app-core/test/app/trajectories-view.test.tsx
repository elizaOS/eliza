// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
  mockClient: {
    getTrajectories: vi.fn(),
    getTrajectoryStats: vi.fn(),
    getTrajectoryConfig: vi.fn(),
    updateTrajectoryConfig: vi.fn(),
    exportTrajectories: vi.fn(),
    clearAllTrajectories: vi.fn(),
  },
  mockConfirmDesktopAction: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => hoisted.mockUseApp(),
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: hoisted.mockClient,
}));

vi.mock("@elizaos/app-core/utils", () => ({
  confirmDesktopAction: (
    ...args: Parameters<typeof hoisted.mockConfirmDesktopAction>
  ) => hoisted.mockConfirmDesktopAction(...args),
}));

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    className?: string;
    variant?: string;
    size?: string;
    "aria-pressed"?: boolean;
  }) =>
    React.createElement(
      "button",
      { type: "button", onClick, disabled, ...rest },
      children,
    ),
  DropdownMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => React.createElement("button", { type: "button", onClick }, children),
  Input: ({
    value,
    onChange,
    ...rest
  }: {
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
    type?: string;
    placeholder?: string;
    className?: string;
  }) => React.createElement("input", { value, onChange, ...rest }),
  Select: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  SelectTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  SelectValue: ({ placeholder }: { placeholder?: string }) =>
    React.createElement("span", null, placeholder ?? ""),
  SelectContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  SelectItem: ({ children }: { children: React.ReactNode; value: string }) =>
    React.createElement("div", null, children),
}));

import type {
  TrajectoryConfig,
  TrajectoryListResult,
  TrajectoryStats,
} from "@elizaos/app-core/api";
import { TrajectoriesView } from "../../src/components/TrajectoriesView";

const { mockClient, mockConfirmDesktopAction, mockUseApp } = hoisted;

const trajectoryList: TrajectoryListResult = {
  trajectories: [],
  total: 0,
  offset: 0,
  limit: 50,
};

const trajectoryStats: TrajectoryStats = {
  totalTrajectories: 0,
  totalLlmCalls: 0,
  totalProviderAccesses: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  averageDurationMs: 0,
  bySource: {},
  byModel: {},
};

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function collectText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : collectText(child)))
    .join("");
}

function createTranslator(): (
  key: string,
  vars?: Record<string, string | number | boolean | undefined>,
) => string {
  return (key, vars) => {
    const labels: Record<string, string> = {
      "common.on": "ON_TEXT",
      "common.off": "OFF_TEXT",
    };
    if (key === "trajectoriesview.ShowingRange" && vars) {
      return `${String(vars.start)}-${String(vars.end)} of ${String(vars.total)}`;
    }
    return labels[key] ?? key;
  };
}

function setBaseMocks(config: TrajectoryConfig): void {
  mockClient.getTrajectories.mockResolvedValue(trajectoryList);
  mockClient.getTrajectoryStats.mockResolvedValue(trajectoryStats);
  mockClient.getTrajectoryConfig.mockResolvedValue(config);
  mockClient.updateTrajectoryConfig.mockResolvedValue(config);
  mockClient.exportTrajectories.mockResolvedValue(
    new Blob(["[]"], { type: "application/json" }),
  );
  mockClient.clearAllTrajectories.mockResolvedValue({ deleted: 0 });
  mockConfirmDesktopAction.mockResolvedValue(true);
  mockUseApp.mockReturnValue({
    t: createTranslator(),
  });
}

describe("TrajectoriesView logging toggle", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    mockConfirmDesktopAction.mockReset();
    for (const fn of Object.values(mockClient)) {
      fn.mockReset();
    }
  });

  it("toggles logging from off to on", async () => {
    setBaseMocks({ enabled: false });
    mockClient.updateTrajectoryConfig.mockResolvedValue({ enabled: true });

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(TrajectoriesView));
    });
    await flush();

    const buttons = tree?.root.findAllByType("button") ?? [];
    const loggingButton = buttons.find(
      (node) => collectText(node) === "OFF_TEXT",
    );
    expect(loggingButton).toBeDefined();

    await act(async () => {
      loggingButton?.props.onClick();
    });

    expect(mockClient.updateTrajectoryConfig).toHaveBeenCalledWith({
      enabled: true,
    });
  });

  it("toggles logging from on to off", async () => {
    setBaseMocks({ enabled: true });
    mockClient.updateTrajectoryConfig.mockResolvedValue({ enabled: false });

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(TrajectoriesView));
    });
    await flush();

    const buttons = tree?.root.findAllByType("button") ?? [];
    const loggingButton = buttons.find(
      (node) => collectText(node) === "ON_TEXT",
    );
    expect(loggingButton).toBeDefined();

    await act(async () => {
      loggingButton?.props.onClick();
    });

    expect(mockClient.updateTrajectoryConfig).toHaveBeenCalledWith({
      enabled: false,
    });
  });
});
