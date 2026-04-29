/**
 * Launchpad playbook engine — types.
 *
 * The engine drives a browser-workspace tab through a hand-curated sequence
 * of steps to launch a token on a specific launchpad (four.meme on BNB,
 * flap.sh on Solana, etc.). Each step maps to one BrowserWorkspaceCommand
 * (or a small composition) and emits a status line in chat before running
 * so the user can watch and follow along.
 *
 * Decisions (locked by plan):
 *   - User confirms each launch transaction in the existing steward
 *     approval surface — no auto-sign anywhere in the engine.
 *   - The engine prefers realistic-* subactions so the cursor moves and
 *     pointer events fire faithfully. See BROWSER_TAB_PRELOAD_SCRIPT.
 *   - dryRun: "stop-before-tx" lets smoke tests exercise the entire
 *     pre-launch flow (wallet connect + form fill + image upload + cursor
 *     overlay) without submitting a real transaction.
 */

export type LaunchpadChain = "evm" | "solana";

export interface LaunchpadTokenMetadata {
  /** Display name of the token. */
  name: string;
  /** Ticker symbol (typically 3–6 chars). */
  symbol: string;
  /** Long-form description shown on the launchpad. */
  description: string;
  /**
   * URL to the token image. The engine drops this into the launchpad's
   * file input via the upload step.
   */
  imageUrl: string;
  /**
   * Optional theme prompt the metadata generator used (kept for narration:
   * "Choosing token name: $WAGMI — theme: cozy DeFi cat").
   */
  theme?: string;
}

export type LaunchpadField =
  | "name"
  | "symbol"
  | "description"
  | "twitter"
  | "telegram"
  | "website";

export type LaunchpadStep =
  | { kind: "navigate"; url: string; narration?: string }
  | {
      kind: "waitFor";
      selector?: string;
      text?: string;
      timeoutMs?: number;
      narration?: string;
    }
  | {
      kind: "connectWallet";
      chain: LaunchpadChain;
      /** Selector for the "Connect Wallet" trigger on the page. */
      connectButton: string;
      /** Optional selector for the wallet provider option (e.g. MetaMask). */
      providerOption?: string;
      narration?: string;
    }
  | {
      kind: "fillField";
      field: LaunchpadField;
      selector: string;
      narration?: string;
    }
  | {
      kind: "uploadImage";
      selector: string;
      narration?: string;
    }
  | {
      kind: "click";
      selector?: string;
      text?: string;
      narration?: string;
    }
  | {
      kind: "confirmTx";
      chain: LaunchpadChain;
      narration?: string;
    }
  | {
      kind: "awaitTxResult";
      explorerUrlPattern?: string;
      timeoutMs?: number;
      narration?: string;
    };

export interface LaunchpadProfile {
  /** Stable id used in logs / metadata (e.g. "four-meme:mainnet"). */
  id: string;
  /** Display name shown in narration ("four.meme", "flap.sh"). */
  displayName: string;
  /** Primary chain the launchpad expects. */
  chain: LaunchpadChain;
  /** URL the engine navigates to before any other step. */
  entryUrl: string;
  /** Cluster (Solana) or chain id (EVM) used by signers downstream. */
  network: { evmChainId?: number; solanaCluster?: "mainnet" | "devnet" | "testnet" };
  /** Ordered step list. */
  steps: LaunchpadStep[];
}

export type LaunchpadDryRun = "off" | "stop-before-tx";

export interface LaunchpadResult {
  ok: boolean;
  profileId: string;
  /** Step index where execution stopped — last completed step on success. */
  stoppedAtStep: number;
  /** Reason (success or failure narration). */
  reason: string;
  /** Optional explorer URL for the resulting transaction. */
  explorerUrl?: string;
}

/**
 * Narration callback signature. The engine calls this BEFORE each step so
 * the user reads the line as the cursor starts moving. Implementations
 * route the line into the page-browser conversation as a synthetic agent
 * message.
 */
export type LaunchpadNarrate = (line: string) => void | Promise<void>;
