// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useAppMock = vi.fn();

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("@elizaos/app-core", async () => {
  const actual =
    await vi.importActual<typeof import("@elizaos/app-core")>(
      "@elizaos/app-core",
    );
  const { createInlineUiMock } = await import("../../../test/app/mockInlineUi");
  return createInlineUiMock(actual);
});

vi.mock("./config-page-sections", () => ({
  BSC_RPC_OPTIONS: [{ id: "eliza-cloud", label: "Eliza Cloud" }],
  EVM_RPC_OPTIONS: [{ id: "eliza-cloud", label: "Eliza Cloud" }],
  SOLANA_RPC_OPTIONS: [{ id: "eliza-cloud", label: "Eliza Cloud" }],
  CloudServicesSection: () => <div data-testid="cloud-services" />,
  RpcConfigSection: () => <div data-testid="rpc-config" />,
}));

vi.mock("./SecretsView", () => ({
  SecretsView: () => null,
}));

import { ConfigPageView } from "./ConfigPageView";

function buildAppState(
  handleWalletApiKeySave: ReturnType<typeof vi.fn>,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
    elizaCloudConnected: true,
    elizaCloudCredits: 11.13,
    elizaCloudCreditsLow: false,
    elizaCloudCreditsCritical: false,
    elizaCloudAuthRejected: false,
    elizaCloudTopUpUrl: "https://example.com/top-up",
    elizaCloudLoginBusy: false,
    walletConfig: null,
    walletApiKeySaving: false,
    handleWalletApiKeySave,
    handleCloudLogin: vi.fn(),
    ...overrides,
  };
}

describe("ConfigPageView", () => {
  afterEach(() => {
    cleanup();
    useAppMock.mockReset();
  });

  beforeEach(() => {
    useAppMock.mockReset();
  });

  it("closes the embedded wallet dialog after a successful save", async () => {
    const handleWalletApiKeySave = vi.fn().mockResolvedValue(true);
    const onWalletSaveSuccess = vi.fn();
    useAppMock.mockReturnValue(buildAppState(handleWalletApiKeySave));

    render(
      <ConfigPageView embedded onWalletSaveSuccess={onWalletSaveSuccess} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => {
      expect(handleWalletApiKeySave).toHaveBeenCalledWith(
        expect.objectContaining({
          selections: {
            evm: "eliza-cloud",
            bsc: "eliza-cloud",
            solana: "eliza-cloud",
          },
          walletNetwork: "mainnet",
        }),
      );
    });
    await waitFor(() => {
      expect(onWalletSaveSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the dialog open when saving fails", async () => {
    const handleWalletApiKeySave = vi.fn().mockResolvedValue(false);
    const onWalletSaveSuccess = vi.fn();
    useAppMock.mockReturnValue(buildAppState(handleWalletApiKeySave));

    render(
      <ConfigPageView embedded onWalletSaveSuccess={onWalletSaveSuccess} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => {
      expect(handleWalletApiKeySave).toHaveBeenCalledTimes(1);
    });
    expect(onWalletSaveSuccess).not.toHaveBeenCalled();
  });

  it("preserves custom rpc selections from a custom wallet config", async () => {
    const handleWalletApiKeySave = vi.fn().mockResolvedValue(true);
    useAppMock.mockReturnValue(
      buildAppState(handleWalletApiKeySave, {
        walletConfig: {
          selectedRpcProviders: {
            evm: "alchemy",
            bsc: "alchemy",
            solana: "helius-birdeye",
          },
          walletNetwork: "mainnet",
        },
      }),
    );

    render(<ConfigPageView embedded />);

    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => {
      expect(handleWalletApiKeySave).toHaveBeenCalledWith(
        expect.objectContaining({
          selections: {
            evm: "alchemy",
            bsc: "alchemy",
            solana: "helius-birdeye",
          },
          walletNetwork: "mainnet",
        }),
      );
    });
  });
});
