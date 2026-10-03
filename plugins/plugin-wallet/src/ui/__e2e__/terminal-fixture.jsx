/**
 * Crypto terminal surface for local mobile/desktop design QA. Market and
 * chart requests go to the fixture dev server, which mounts the real terminal
 * route handler, so the page renders live CoinGecko data; the wallet tab uses
 * an empty app store.
 */
import { client } from "@elizaos/ui/api";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MockAppProvider } from "../../../../../packages/ui/src/storybook/mock-providers";
import { CryptoTerminalView } from "../CryptoTerminalView";
import "./wallet-fixture.css";

client.fetch = async (path) => {
  const response = await window.fetch(path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

const noopAsync = async () => {};
const root = document.getElementById("root");
if (!root) throw new Error("Crypto terminal fixture root is missing");

createRoot(root).render(
  <StrictMode>
    <MockAppProvider
      value={{
        walletEnabled: false,
        walletAddresses: { evmAddress: null, solanaAddress: null },
        walletConfig: null,
        walletBalances: null,
        walletNfts: null,
        loadWalletConfig: noopAsync,
        loadBalances: noopAsync,
        loadNfts: noopAsync,
        setState: () => {},
        setTab: () => {},
        setActionNotice: () => {},
      }}
    >
      <CryptoTerminalView />
    </MockAppProvider>
  </StrictMode>,
);
