"use client";

import { Button, Card, CardContent, CardHeader, CardTitle } from "@elizaos/ui";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import { Coins, Loader2, ShieldCheck, Wallet } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { erc20Abi } from "viem";
import { useAccount, useConfig, useSwitchChain } from "wagmi";
import { sendTransaction, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import type {
  CryptoStatusResponse,
  CryptoStatusTokenOption,
} from "@/lib/types/crypto-status";

type DirectNetwork = "base" | "bsc" | "solana";

interface DirectCryptoCreditCardProps {
  amount: number | null;
  promoCode?: "bsc";
  status: CryptoStatusResponse | null;
  accountWalletAddress: string | null;
  onSuccess: () => Promise<void> | void;
  surface?: "default" | "cloud";
  lockedNetwork?: DirectNetwork;
}

type DirectNetworkConfig = NonNullable<
  NonNullable<CryptoStatusResponse["directWallet"]>["networks"]
>[number];

const NETWORK_LABELS: Record<DirectNetwork, string> = {
  base: "Base",
  bsc: "BSC",
  solana: "Solana",
};

function formatAddress(value: string | null | undefined) {
  if (!value) return "";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

async function createDirectPayment(params: {
  amount: number;
  network: DirectNetwork;
  payerAddress: string;
  tokenSymbol?: string;
  promoCode?: "bsc";
}) {
  const res = await fetch("/api/crypto/direct-payments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not create crypto payment");
  return data as {
    paymentId: string;
    instructions: {
      chainId?: number;
      tokenSymbol: string;
      tokenKind: "native" | "bep20" | "erc20" | "spl";
      tokenAddress?: `0x${string}`;
      tokenMint?: string;
      tokenDecimals: number;
      receiveAddress: string;
      amountUnits: string;
      amountToken: string;
      creditsToAdd: string;
      bonusCredits: number;
    };
  };
}

async function confirmDirectPayment(
  paymentId: string,
  transactionHash: string,
) {
  const res = await fetch(`/api/crypto/direct-payments/${paymentId}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactionHash }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(data.error || data.message || "Could not confirm payment");
  return data;
}

export function DirectCryptoCreditCard({
  amount,
  promoCode,
  status,
  accountWalletAddress,
  onSuccess,
  surface = "default",
  lockedNetwork,
}: DirectCryptoCreditCardProps) {
  const [network, setNetwork] = useState<DirectNetwork>(
    lockedNetwork ?? (promoCode === "bsc" ? "bsc" : "base"),
  );
  const [tokenSymbol, setTokenSymbol] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const evm = useAccount();
  const wagmiConfig = useConfig();
  const { switchChainAsync } = useSwitchChain();
  const solana = useWallet();
  const { connection } = useConnection();
  const { setVisible: setSolanaModalVisible } = useWalletModal();

  const networks = status?.directWallet?.networks ?? [];
  const enabledNetworks = networks.filter(
    (item) =>
      item.enabled && (!lockedNetwork || item.network === lockedNetwork),
  );
  const selected =
    enabledNetworks.find((item) => item.network === network) ??
    enabledNetworks[0];

  const tokenOptions: CryptoStatusTokenOption[] = selected?.tokens ?? [];
  const selectedToken: CryptoStatusTokenOption | undefined = useMemo(() => {
    if (tokenOptions.length === 0) return undefined;
    const match = tokenOptions.find(
      (t) => t.symbol.toUpperCase() === (tokenSymbol ?? "").toUpperCase(),
    );
    return match ?? tokenOptions[0];
  }, [tokenOptions, tokenSymbol]);

  // When the network changes (or the underlying token list does), reset the
  // selected token to the network's default so we don't carry a stale BSC
  // selection into Base/Solana.
  useEffect(() => {
    setTokenSymbol(null);
  }, [selected?.network]);

  const bscPromo =
    promoCode === "bsc" && network === "bsc" && amount !== null && amount >= 10;
  const expectedCredits = amount === null ? 0 : amount + (bscPromo ? 5 : 0);
  const canPay = Boolean(amount && amount > 0 && selected);

  const connectedAddress = useMemo(() => {
    if (selected?.network === "solana")
      return solana.publicKey?.toBase58() ?? null;
    return evm.isConnected ? (evm.address ?? null) : null;
  }, [evm.address, evm.isConnected, selected?.network, solana.publicKey]);

  const walletMatches =
    connectedAddress &&
    accountWalletAddress &&
    (selected?.network === "solana"
      ? connectedAddress === accountWalletAddress
      : connectedAddress.toLowerCase() === accountWalletAddress.toLowerCase());

  async function sendEvmPayment(
    cfg: DirectNetworkConfig,
    payment: Awaited<ReturnType<typeof createDirectPayment>>,
  ) {
    if (!evm.address) throw new Error("Connect your EVM wallet first");
    if (!cfg.chainId) {
      throw new Error("Payment network is missing chain configuration");
    }
    if (evm.chainId !== cfg.chainId) {
      await switchChainAsync({ chainId: cfg.chainId });
    }
    if (payment.instructions.tokenKind === "native") {
      const hash = await sendTransaction(wagmiConfig, {
        to: payment.instructions.receiveAddress as `0x${string}`,
        value: BigInt(payment.instructions.amountUnits),
        chainId: cfg.chainId,
      });
      await waitForTransactionReceipt(wagmiConfig, { hash, chainId: cfg.chainId });
      return hash;
    }
    if (!payment.instructions.tokenAddress) {
      throw new Error("Payment network is missing token configuration");
    }
    const hash = await writeContract(wagmiConfig, {
      address: payment.instructions.tokenAddress,
      abi: erc20Abi,
      functionName: "transfer",
      args: [
        payment.instructions.receiveAddress as `0x${string}`,
        BigInt(payment.instructions.amountUnits),
      ],
      chainId: cfg.chainId,
    });
    await waitForTransactionReceipt(wagmiConfig, {
      hash,
      chainId: cfg.chainId,
    });
    return hash;
  }

  async function sendSolanaPayment(
    payment: Awaited<ReturnType<typeof createDirectPayment>>,
  ) {
    if (!solana.publicKey || !solana.sendTransaction) {
      throw new Error("Connect your Solana wallet first");
    }
    if (!payment.instructions.tokenMint) {
      throw new Error("Payment network is missing token configuration");
    }
    const mint = new PublicKey(payment.instructions.tokenMint);
    const receiver = new PublicKey(payment.instructions.receiveAddress);
    const sourceAta = getAssociatedTokenAddressSync(mint, solana.publicKey);
    const destinationAta = getAssociatedTokenAddressSync(mint, receiver);
    const tx = new Transaction();
    if (!(await connection.getAccountInfo(destinationAta))) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          solana.publicKey,
          destinationAta,
          receiver,
          mint,
        ),
      );
    }
    tx.add(
      createTransferCheckedInstruction(
        sourceAta,
        mint,
        destinationAta,
        solana.publicKey,
        BigInt(payment.instructions.amountUnits),
        payment.instructions.tokenDecimals,
      ),
    );
    return await solana.sendTransaction(tx, connection);
  }

  async function handlePay() {
    if (!amount || !selected) return;
    if (!accountWalletAddress) {
      toast.error(
        "Sign in with, or verify, the wallet attached to your account first.",
      );
      return;
    }
    if (!connectedAddress) {
      if (selected.network === "solana") setSolanaModalVisible(true);
      toast.error(
        `Connect your ${NETWORK_LABELS[selected.network]} wallet first.`,
      );
      return;
    }
    if (!walletMatches) {
      toast.error(
        "The connected wallet must match the wallet on your account.",
      );
      return;
    }

    setBusy(true);
    try {
      const payment = await createDirectPayment({
        amount,
        network: selected.network,
        payerAddress: connectedAddress,
        tokenSymbol: selectedToken?.symbol,
        promoCode,
      });
      const hash =
        selected.network === "solana"
          ? await sendSolanaPayment(payment)
          : await sendEvmPayment(selected, payment);
      toast.message("Transaction sent. Confirming on-chain...");
      await confirmDirectPayment(payment.paymentId, hash);
      toast.success(
        `Added $${payment.instructions.creditsToAdd} in cloud credit`,
      );
      await onSuccess();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Payment failed");
    } finally {
      setBusy(false);
    }
  }

  const isCloudSurface = surface === "cloud";
  const cardClassName = isCloudSurface
    ? "rounded-xs border-black/12 bg-white/88 text-black shadow-xl backdrop-blur-md"
    : "border-border bg-card text-card-fg";
  const mutedTextClassName = isCloudSurface ? "text-black/62" : "text-muted";
  const titleClassName = isCloudSurface ? "text-black" : "text-txt-strong";
  const dividerClassName = isCloudSurface
    ? "border-t border-black/10"
    : "border-t border-border/60";
  const iconBoxClassName = isCloudSurface
    ? "rounded-xs border-black/12 bg-black text-white"
    : "border-accent/20 bg-accent-subtle text-accent";
  const segmentClassName = isCloudSurface
    ? "border-black/10 bg-black/[0.03]"
    : "border-border bg-bg-muted";
  const selectedSegmentClassName = isCloudSurface
    ? "bg-black text-white"
    : "bg-accent text-accent-foreground";
  const unselectedSegmentClassName = isCloudSurface
    ? "text-black/58 hover:bg-black/[0.06] hover:text-black"
    : "text-muted-foreground hover:bg-bg-hover hover:text-txt";
  const infoTileClassName = isCloudSurface
    ? "border-black/10 bg-black/[0.03]"
    : "border-border bg-bg-muted";
  const infoValueClassName = isCloudSurface ? "text-black" : "text-txt-strong";
  const promoClassName = isCloudSurface
    ? "border-black/12 bg-black/[0.04] text-black/72"
    : "border-warn/25 bg-warn-subtle text-warn";
  const surfaceButtonClassName = isCloudSurface
    ? "rounded-xs border-black bg-black text-white hover:bg-black/82"
    : undefined;
  const payButtonClassName = isCloudSurface
    ? "min-w-[172px] rounded-xs bg-black text-white hover:bg-black/82"
    : "min-w-[172px]";
  const cloudButtonStyle: CSSProperties | undefined = isCloudSurface
    ? { backgroundColor: "#000", borderColor: "#000", color: "#fff" }
    : undefined;
  const showNetworkSelector = !lockedNetwork && enabledNetworks.length > 1;
  const showTokenSelector = tokenOptions.length > 1;

  if (!status?.directWallet?.enabled) {
    return (
      <Card className={cardClassName}>
        <CardContent className="p-5">
          <p className={`text-sm ${mutedTextClassName}`}>
            Direct wallet payments are not configured yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cardClassName}>
      <CardHeader className="flex-row items-center gap-3 space-y-0 p-5 pb-4">
        <div
          className={`flex size-9 shrink-0 items-center justify-center border ${iconBoxClassName}`}
        >
          <Wallet className="h-4 w-4" />
        </div>
        <div>
          <CardTitle className={`text-base ${titleClassName}`}>
            Wallet payment
          </CardTitle>
          <p className={`mt-1 text-sm ${mutedTextClassName}`}>
            Pay from the wallet attached to your account.
          </p>
        </div>
      </CardHeader>
      <CardContent className={`space-y-4 p-5 ${dividerClassName}`}>
        {showNetworkSelector ? (
          <div
            className={`grid grid-cols-3 gap-2 rounded-xs border p-1 text-xs sm:gap-3 ${segmentClassName}`}
          >
            {enabledNetworks.map((item) => (
              <button
                key={item.network}
                type="button"
                onClick={() => setNetwork(item.network)}
                className={`min-h-10 rounded-xs px-3 py-2 font-medium transition-colors ${
                  selected?.network === item.network
                    ? selectedSegmentClassName
                    : unselectedSegmentClassName
                }`}
              >
                {NETWORK_LABELS[item.network]}
              </button>
            ))}
          </div>
        ) : null}

        {showTokenSelector ? (
          <div className="space-y-1">
            <div className={`text-xs ${mutedTextClassName}`}>Pay with</div>
            <div
              aria-label="Token"
              role="radiogroup"
              className={`grid grid-cols-4 gap-2 rounded-xs border p-1 text-xs sm:gap-3 ${segmentClassName}`}
            >
              {tokenOptions.map((option) => {
                const active =
                  selectedToken?.symbol.toUpperCase() ===
                  option.symbol.toUpperCase();
                return (
                  <button
                    key={option.symbol}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTokenSymbol(option.symbol)}
                    className={`min-h-10 rounded-xs px-3 py-2 font-medium transition-colors ${
                      active
                        ? selectedSegmentClassName
                        : unselectedSegmentClassName
                    }`}
                  >
                    {option.symbol === "U" ? "$U" : option.symbol}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div
          className={`grid grid-cols-1 gap-2 text-xs sm:grid-cols-3 sm:gap-3 ${mutedTextClassName}`}
        >
          <div className={`rounded-xs border p-3 ${infoTileClassName}`}>
            <div>Token</div>
            <div className={`mt-1 ${infoValueClassName}`}>
              {selectedToken
                ? selectedToken.symbol === "U"
                  ? "$U"
                  : selectedToken.symbol
                : (selected?.tokenSymbol ?? "-")}
            </div>
          </div>
          <div className={`rounded-xs border p-3 ${infoTileClassName}`}>
            <div>Wallet</div>
            <div className={`mt-1 truncate ${infoValueClassName}`}>
              {formatAddress(connectedAddress) || "Not connected"}
            </div>
          </div>
          <div className={`rounded-xs border p-3 ${infoTileClassName}`}>
            <div>Cloud credit</div>
            <div className={`mt-1 ${infoValueClassName}`}>
              ${expectedCredits.toFixed(2)}
            </div>
          </div>
        </div>

        {bscPromo && (
          <div
            className={`flex items-center gap-2 rounded-xs border px-3 py-2 text-xs font-medium ${promoClassName}`}
          >
            <Coins className="h-4 w-4" />
            BSC promotion applied: +$5 cloud credit
          </div>
        )}

        {!walletMatches && connectedAddress && accountWalletAddress && (
          <div
            className={`rounded-xs border px-3 py-2 text-xs ${promoClassName}`}
          >
            Connected wallet must match your account wallet (
            {formatAddress(accountWalletAddress)}).
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {selected?.network === "solana" ? (
            <Button
              type="button"
              variant="surface"
              onClick={() => setSolanaModalVisible(true)}
              className={surfaceButtonClassName}
              style={cloudButtonStyle}
            >
              {solana.publicKey ? "Solana connected" : "Connect Solana"}
            </Button>
          ) : (
            <ConnectButton.Custom>
              {({ account, chain, openAccountModal, openConnectModal }) => (
                <Button
                  type="button"
                  variant={isCloudSurface ? "default" : "surface"}
                  onClick={account ? openAccountModal : openConnectModal}
                  className={surfaceButtonClassName}
                  style={cloudButtonStyle}
                >
                  {account
                    ? `${account.address.slice(0, 6)}...${account.address.slice(-4)}`
                    : chain?.unsupported
                      ? "Wrong network"
                      : "Connect Wallet"}
                </Button>
              )}
            </ConnectButton.Custom>
          )}
          <Button
            type="button"
            onClick={handlePay}
            disabled={!canPay || busy}
            className={payButtonClassName}
            style={cloudButtonStyle}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Pay and add credits
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
