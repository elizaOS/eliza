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
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { erc20Abi } from "viem";
import { useAccount, useConfig, useSwitchChain } from "wagmi";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";
import type { CryptoStatusResponse } from "@/lib/types/crypto-status";

type DirectNetwork = "base" | "bsc" | "solana";

interface DirectCryptoCreditCardProps {
  amount: number | null;
  promoCode?: "bsc";
  status: CryptoStatusResponse | null;
  accountWalletAddress: string | null;
  onSuccess: () => Promise<void> | void;
  surface?: "default" | "cloud";
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
}: DirectCryptoCreditCardProps) {
  const [network, setNetwork] = useState<DirectNetwork>(
    promoCode === "bsc" ? "bsc" : "base",
  );
  const [busy, setBusy] = useState(false);
  const evm = useAccount();
  const wagmiConfig = useConfig();
  const { switchChainAsync } = useSwitchChain();
  const solana = useWallet();
  const { connection } = useConnection();
  const { setVisible: setSolanaModalVisible } = useWalletModal();

  const networks = status?.directWallet?.networks ?? [];
  const enabledNetworks = networks.filter((item) => item.enabled);
  const selected =
    enabledNetworks.find((item) => item.network === network) ??
    enabledNetworks[0];
  const bscPromo =
    promoCode === "bsc" && network === "bsc" && amount !== null && amount >= 10;
  const expectedCredits = amount === null ? 0 : amount + (bscPromo ? 5 : 0);
  const canPay = Boolean(amount && amount > 0 && selected);

  const connectedAddress = useMemo(() => {
    if (selected?.network === "solana")
      return solana.publicKey?.toBase58() ?? null;
    return evm.address ?? null;
  }, [evm.address, selected?.network, solana.publicKey]);

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
    if (!cfg.chainId || !payment.instructions.tokenAddress) {
      throw new Error("Payment network is missing token configuration");
    }
    if (evm.chainId !== cfg.chainId) {
      await switchChainAsync({ chainId: cfg.chainId });
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
    ? "border-white/12 bg-black/78 text-white shadow-2xl backdrop-blur-xl"
    : "border-border bg-card text-card-fg";
  const mutedTextClassName = isCloudSurface ? "text-white/60" : "text-muted";
  const titleClassName = isCloudSurface ? "text-white" : "text-txt-strong";
  const dividerClassName = isCloudSurface
    ? "border-t border-white/10"
    : "border-t border-border/60";
  const iconBoxClassName = isCloudSurface
    ? "border-white/12 bg-white/[0.06] text-[#FF5800]"
    : "border-accent/20 bg-accent-subtle text-accent";
  const segmentClassName = isCloudSurface
    ? "border-white/10 bg-white/[0.04]"
    : "border-border bg-bg-muted";
  const selectedSegmentClassName = isCloudSurface
    ? "bg-[#FF5800] text-black"
    : "bg-accent text-accent-foreground";
  const unselectedSegmentClassName = isCloudSurface
    ? "text-white/58 hover:bg-white/[0.06] hover:text-white"
    : "text-muted-foreground hover:bg-bg-hover hover:text-txt";
  const infoTileClassName = isCloudSurface
    ? "border-white/10 bg-white/[0.05]"
    : "border-border bg-bg-muted";
  const infoValueClassName = isCloudSurface ? "text-white" : "text-txt-strong";
  const promoClassName = isCloudSurface
    ? "border-[#FF5800]/30 bg-[#FF5800]/12 text-[#FFB087]"
    : "border-warn/25 bg-warn-subtle text-warn";
  const surfaceButtonClassName = isCloudSurface
    ? "border-white/14 bg-white/[0.06] text-white hover:bg-white/10"
    : undefined;
  const payButtonClassName = isCloudSurface
    ? "min-w-[172px] bg-[#FF5800] text-black hover:bg-white"
    : "min-w-[172px]";

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
        <div
          className={`grid grid-cols-3 gap-2 rounded-sm border p-1 text-xs sm:gap-3 ${segmentClassName}`}
        >
          {enabledNetworks.map((item) => (
            <button
              key={item.network}
              type="button"
              onClick={() => setNetwork(item.network)}
              className={`min-h-10 rounded-sm px-3 py-2 font-medium transition-colors ${
                selected?.network === item.network
                  ? selectedSegmentClassName
                  : unselectedSegmentClassName
              }`}
            >
              {NETWORK_LABELS[item.network]}
            </button>
          ))}
        </div>

        <div
          className={`grid grid-cols-1 gap-2 text-xs sm:grid-cols-3 sm:gap-3 ${mutedTextClassName}`}
        >
          <div className={`border p-3 ${infoTileClassName}`}>
            <div>Token</div>
            <div className={`mt-1 ${infoValueClassName}`}>
              {selected?.tokenSymbol ?? "-"}
            </div>
          </div>
          <div className={`border p-3 ${infoTileClassName}`}>
            <div>Wallet</div>
            <div className={`mt-1 truncate ${infoValueClassName}`}>
              {formatAddress(connectedAddress) || "Not connected"}
            </div>
          </div>
          <div className={`border p-3 ${infoTileClassName}`}>
            <div>Cloud credit</div>
            <div className={`mt-1 ${infoValueClassName}`}>
              ${expectedCredits.toFixed(2)}
            </div>
          </div>
        </div>

        {bscPromo && (
          <div
            className={`flex items-center gap-2 border px-3 py-2 text-xs font-medium ${promoClassName}`}
          >
            <Coins className="h-4 w-4" />
            BSC promotion applied: +$5 cloud credit
          </div>
        )}

        {!walletMatches && connectedAddress && accountWalletAddress && (
          <div className={`border px-3 py-2 text-xs ${promoClassName}`}>
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
            >
              {solana.publicKey ? "Solana connected" : "Connect Solana"}
            </Button>
          ) : (
            <ConnectButton
              showBalance={false}
              chainStatus="icon"
              accountStatus="address"
            />
          )}
          <Button
            type="button"
            onClick={handlePay}
            disabled={!canPay || busy}
            className={payButtonClassName}
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
