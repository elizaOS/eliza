/** Exercises wallet-provider composition and required host configuration with deterministic provider boundaries. */
import * as React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

// Mock the EVM and Solana provider modules so the test does not pull in
// real wagmi / Solana peer dep trees (and so we can assert that each
// provider is mounted with the right props).

const mockCreateDefaultWagmiConfig = vi.fn((opts: unknown) => ({
  kind: "wagmi-config",
  opts,
}));
const mockEVMProviderRender = vi.fn((_props: unknown) => null);
const mockSolanaProviderRender = vi.fn((_props: unknown) => null);

vi.doMock("../providers/EVMProvider.js", () => ({
  createDefaultWagmiConfig: mockCreateDefaultWagmiConfig,
  EVMWalletProvider: ({
    children,
    ...props
  }: { children?: React.ReactNode } & Record<string, unknown>) => {
    mockEVMProviderRender(props);
    return React.createElement(
      "div",
      {
        "data-testid": "evm-wrap",
        "data-config-kind": (props.config as { kind?: string })?.kind,
      },
      children,
    );
  },
}));

vi.doMock("../providers/SolanaProvider.js", () => ({
  SolanaWalletProvider: ({
    children,
    ...props
  }: { children?: React.ReactNode } & Record<string, unknown>) => {
    mockSolanaProviderRender(props);
    return React.createElement(
      "div",
      {
        "data-testid": "sol-wrap",
        "data-endpoint": String(props.endpoint ?? ""),
      },
      children,
    );
  },
  createDefaultSolanaWallets: () => [],
  DEFAULT_SOLANA_WALLETS: [],
}));

vi.doMock("../components/LoginForm.js", () => ({
  LoginForm: (props: Record<string, unknown>) =>
    React.createElement("div", {
      "data-testid": "steward-login",
      "data-show-wallets": JSON.stringify(props.showWallets ?? null),
      "data-title": String(props.title ?? ""),
    }),
}));

const { LoginFormWithWallets } = await import(
  "../components/LoginFormWithWallets.js"
);

describe("<LoginFormWithWallets />", () => {
  afterEach(() => vi.unstubAllEnvs());

  test.each([undefined, "", "   "])(
    "rejects missing WalletConnect project configuration: %s",
    (projectId) => {
      vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", undefined);
      expect(() =>
        renderToString(
          React.createElement(LoginFormWithWallets, { evm: { projectId } }),
        ),
      ).toThrow("Configure evm.projectId");
    },
  );

  test("uses the host's WalletConnect environment configuration", () => {
    vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "host-owned-project");
    renderToString(React.createElement(LoginFormWithWallets));
    expect(mockCreateDefaultWagmiConfig.mock.calls.at(-1)?.[0]).toMatchObject({
      projectId: "host-owned-project",
    });
  });

  test("wraps both EVM and Solana providers by default and renders <LoginForm>", () => {
    const html = renderToString(
      React.createElement(LoginFormWithWallets, {
        title: "sign in",
        evm: { projectId: "test-pid" },
      }),
    );
    expect(html).toContain('data-testid="evm-wrap"');
    expect(html).toContain('data-testid="sol-wrap"');
    expect(html).toContain('data-testid="steward-login"');
    expect(html).toContain('data-config-kind="wagmi-config"');
  });

  test("default showWallets is { evm: true, solana: true } when not overridden", () => {
    const html = renderToString(
      React.createElement(LoginFormWithWallets, {
        evm: { projectId: "p" },
      }),
    );
    expect(html).toContain(
      'data-show-wallets="{&quot;evm&quot;:true,&quot;solana&quot;:true}"',
    );
  });

  test("default EVM config includes Gnosis", () => {
    renderToString(
      React.createElement(LoginFormWithWallets, {
        evm: { projectId: "p" },
      }),
    );
    const opts = mockCreateDefaultWagmiConfig.mock.calls.at(-1)?.[0] as {
      chains?: Array<{ id: number }>;
    };
    expect(opts.chains?.map((chain) => chain.id)).toContain(100);
  });

  test("forwards extra EVM wallet entries into the default wagmi config", () => {
    const stewardWallet = () => {
      throw new Error(
        "Connector construction is outside this provider composition test",
      );
    };
    renderToString(
      React.createElement(LoginFormWithWallets, {
        evm: { projectId: "p", wallets: [stewardWallet] },
      }),
    );
    const opts = mockCreateDefaultWagmiConfig.mock.calls.at(-1)?.[0] as {
      wallets?: unknown[];
    };
    expect(opts.wallets).toEqual([stewardWallet]);
  });

  test("enable={{ evm: false }} skips EVM wrap", () => {
    const html = renderToString(
      React.createElement(LoginFormWithWallets, {
        enable: { evm: false },
      }),
    );
    expect(html).not.toContain('data-testid="evm-wrap"');
    expect(html).toContain('data-testid="sol-wrap"');
    expect(html).toContain('data-testid="steward-login"');
  });

  test("enable={{ solana: false }} skips Solana wrap", () => {
    const html = renderToString(
      React.createElement(LoginFormWithWallets, {
        enable: { solana: false },
        evm: { projectId: "p" },
      }),
    );
    expect(html).toContain('data-testid="evm-wrap"');
    expect(html).not.toContain('data-testid="sol-wrap"');
  });

  test("custom evm.config bypasses createDefaultWagmiConfig", () => {
    const customConfig = { kind: "custom-wagmi-config" };
    const html = renderToString(
      React.createElement(LoginFormWithWallets, {
        evm: { config: customConfig as unknown as never },
      }),
    );
    // Custom config flows through to <EVMWalletProvider config={...}>.
    expect(html).toContain('data-config-kind="custom-wagmi-config"');
  });

  test("solana.endpoint override is respected", () => {
    const html = renderToString(
      React.createElement(LoginFormWithWallets, {
        evm: { projectId: "p" },
        solana: { endpoint: "https://my.helius.rpc" },
      }),
    );
    expect(html).toContain('data-endpoint="https://my.helius.rpc"');
  });

  test("forwards LoginForm props (title)", () => {
    const html = renderToString(
      React.createElement(LoginFormWithWallets, {
        title: "custom title",
        evm: { projectId: "p" },
      }),
    );
    expect(html).toContain('data-title="custom title"');
  });

  test("explicit showWallets prop wins over the auto default", () => {
    const html = renderToString(
      React.createElement(LoginFormWithWallets, {
        showWallets: { evm: true, solana: false },
        evm: { projectId: "p" },
      }),
    );
    expect(html).toContain(
      'data-show-wallets="{&quot;evm&quot;:true,&quot;solana&quot;:false}"',
    );
  });
});
