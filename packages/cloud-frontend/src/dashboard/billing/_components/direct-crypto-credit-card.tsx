"use client";

import { BrandCard, CornerBrackets } from "@elizaos/ui";
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

  if (!status?.directWallet?.enabled) {
    return (
      <BrandCard className="relative border-white/10">
        <CornerBrackets size="sm" className="opacity-40" />
        <p className="relative z-10 text-sm font-mono text-white/60">
          Direct wallet payments are not configured yet.
        </p>
      </BrandCard>
    );
  }

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-4">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-[#FF5800]" />
          <h4 className="font-mono text-sm uppercase text-white">
            Wallet payment
          </h4>
        </div>

        <div className="flex flex-wrap gap-2">
          {enabledNetworks.map((item) => (
            <button
              key={item.network}
              type="button"
              onClick={() => setNetwork(item.network)}
              className={`border px-3 py-2 text-xs font-mono uppercase transition-colors ${
                selected?.network === item.network
                  ? "border-[#FF5800] bg-[#FF5800] text-white"
                  : "border-white/20 bg-transparent text-white/70 hover:border-white/40"
              }`}
            >
              {NETWORK_LABELS[item.network]}
            </button>
          ))}
        </div>

        <div className="grid gap-3 text-xs font-mono text-white/65 sm:grid-cols-3">
          <div className="border border-white/10 bg-black/30 p-3">
            <div className="text-white/40">Token</div>
            <div className="mt-1 text-white">
              {selected?.tokenSymbol ?? "-"}
            </div>
          </div>
          <div className="border border-white/10 bg-black/30 p-3">
            <div className="text-white/40">Wallet</div>
            <div className="mt-1 text-white">
              {formatAddress(connectedAddress) || "Not connected"}
            </div>
          </div>
          <div className="border border-white/10 bg-black/30 p-3">
            <div className="text-white/40">Cloud credit</div>
            <div className="mt-1 text-white">${expectedCredits.toFixed(2)}</div>
          </div>
        </div>

        {bscPromo && (
          <div className="flex items-center gap-2 border border-[#FF5800]/40 bg-[#FF5800]/10 px-3 py-2 text-xs font-mono text-[#ffb088]">
            <Coins className="h-4 w-4" />
            BSC promotion applied: +$5 cloud credit
          </div>
        )}

        {!walletMatches && connectedAddress && accountWalletAddress && (
          <div className="border border-orange-400/30 bg-orange-400/10 px-3 py-2 text-xs font-mono text-orange-200">
            Connected wallet must match your account wallet (
            {formatAddress(accountWalletAddress)}).
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {selected?.network === "solana" ? (
            <button
              type="button"
              onClick={() => setSolanaModalVisible(true)}
              className="border border-white/20 px-4 py-2 text-sm font-mono text-white hover:border-white/40"
            >
              {solana.publicKey ? "Solana connected" : "Connect Solana"}
            </button>
          ) : (
            <ConnectButton
              showBalance={false}
              chainStatus="icon"
              accountStatus="address"
            />
          )}
          <button
            type="button"
            onClick={handlePay}
            disabled={!canPay || busy}
            className="flex items-center justify-center gap-2 bg-[#e1e1e1] px-5 py-2.5 font-mono text-sm font-medium text-black transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Pay and add credits
          </button>
        </div>
      </div>
    </BrandCard>
  );
}
