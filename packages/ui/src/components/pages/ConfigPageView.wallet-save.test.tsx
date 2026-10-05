// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfigPageView } from "./ConfigPageView";

const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../../state/app-store", () => ({
  useAppSelectorShallow: (
    select: (value: Record<string, unknown>) => unknown,
  ) => select(state.value),
}));
vi.mock("../../agent-surface/useAgentElement", () => ({
  useAgentElement: () => ({ ref: undefined, agentProps: {} }),
}));
vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./config-page-sections", () => ({
  CloudServicesSection: () => null,
  RpcConfigSection: () => null,
}));

beforeEach(() => {
  state.value = {
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
    elizaCloudConnected: true,
    walletConfig: {
      walletNetwork: "devnet",
      selectedRpcProviders: {
        evm: "eliza-cloud",
        bsc: "eliza-cloud",
        solana: "eliza-cloud",
      },
    },
    walletApiKeySaving: false,
    handleWalletApiKeySave: vi.fn(async () => true),
    setActionNotice: vi.fn(),
  };
});
afterEach(cleanup);

it("shows invalid stored network errors without dispatching a wallet update", async () => {
  const onWalletSaveSuccess = vi.fn();
  render(<ConfigPageView embedded onWalletSaveSuccess={onWalletSaveSuccess} />);
  fireEvent.click(screen.getByTestId("wallet-rpc-save"));
  await waitFor(() =>
    expect(state.value.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Invalid wallet network"),
      "error",
    ),
  );
  expect(state.value.handleWalletApiKeySave).not.toHaveBeenCalled();
  expect(onWalletSaveSuccess).not.toHaveBeenCalled();
});

it("still dispatches valid testnet updates and reports successful saves", async () => {
  state.value.walletConfig = {
    ...(state.value.walletConfig as object),
    walletNetwork: "testnet",
  };
  const onWalletSaveSuccess = vi.fn();
  render(<ConfigPageView embedded onWalletSaveSuccess={onWalletSaveSuccess} />);
  fireEvent.click(screen.getByTestId("wallet-rpc-save"));
  await waitFor(() => expect(onWalletSaveSuccess).toHaveBeenCalledOnce());
  expect(state.value.handleWalletApiKeySave).toHaveBeenCalledWith(
    expect.objectContaining({ walletNetwork: "testnet" }),
  );
  expect(state.value.setActionNotice).not.toHaveBeenCalled();
});
