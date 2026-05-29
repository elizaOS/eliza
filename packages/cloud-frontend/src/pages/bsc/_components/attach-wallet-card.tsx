"use client";

/**
 * AttachWalletCard — surface for OAuth-signed-in users on /bsc to verify a BSC
 * wallet against their account before the purchase UI is enabled.
 *
 * Backed by `useAttachWallet`, which runs the GET nonce -> sign SIWE -> POST
 * attach -> invalidate user-profile flow. Renders inside the same
 * `StewardWalletProviders` tree as `DirectCryptoCreditCard`, so wagmi /
 * RainbowKit hooks resolve.
 */

import { Button, Card, CardContent, CardHeader, CardTitle } from "@elizaos/ui";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Loader2, ShieldCheck, Wallet } from "lucide-react";
import type { CSSProperties } from "react";
import { toast } from "sonner";
import { useAccount } from "wagmi";
import { useAttachWallet } from "@/lib/data/use-attach-wallet";
import { useT } from "@/providers/I18nProvider";

const CLOUD_BUTTON_STYLE: CSSProperties = {
  backgroundColor: "#000",
  borderColor: "#000",
  color: "#fff",
};

interface AttachWalletCardProps {
  /** Chain ID embedded in the SIWE message. Defaults to BSC (56). */
  chainId?: number;
}

export function AttachWalletCard({ chainId = 56 }: AttachWalletCardProps) {
  const t = useT();
  const { address, isConnected } = useAccount();
  const attach = useAttachWallet({ chainId });

  const handleAttach = () => {
    attach.mutate(undefined, {
      onSuccess: () => {
        toast.success(
          t("cloud.attachWallet.verified", {
            defaultValue: "Wallet verified — you can pay now.",
          }),
        );
      },
      onError: (error) => {
        if (error.code === "signature_rejected") {
          toast.message(
            t("cloud.attachWallet.signatureCanceled", {
              defaultValue:
                "Signature canceled. Try again to verify your wallet.",
            }),
          );
          return;
        }
        if (error.code === "wallet_not_connected") {
          toast.error(
            t("cloud.attachWallet.connectFirst", {
              defaultValue: "Connect a wallet before verifying.",
            }),
          );
          return;
        }
        toast.error(error.message);
      },
    });
  };

  const busy = attach.isPending;

  return (
    <Card className="rounded-xs border-black/12 bg-white/88 text-black shadow-xl backdrop-blur-md">
      <CardHeader className="flex-row items-center gap-3 space-y-0 p-5 pb-4">
        <div className="flex size-9 shrink-0 items-center justify-center border rounded-xs border-black/12 bg-black text-white">
          <Wallet className="h-4 w-4" />
        </div>
        <div>
          <CardTitle className="text-base text-black">
            {t("cloud.attachWallet.title", {
              defaultValue: "Verify your BSC wallet",
            })}
          </CardTitle>
          <p className="mt-1 text-sm text-black/62">
            {t("cloud.attachWallet.description", {
              defaultValue:
                "Sign a one-time message so credits can land on your account when you pay. We don't move funds — this is only a signature.",
            })}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 border-t border-black/10 p-5">
        <ol className="space-y-2 text-sm text-black/72">
          <li>
            {t("cloud.attachWallet.step1", {
              defaultValue: "1. Connect the BSC wallet you'll pay from.",
            })}
          </li>
          <li>
            {t("cloud.attachWallet.step2", {
              defaultValue: "2. Sign the verification message.",
            })}
          </li>
          <li>
            {t("cloud.attachWallet.step3", {
              defaultValue: "3. Buy cloud credit with the $5 BSC bonus.",
            })}
          </li>
        </ol>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <ConnectButton.Custom>
            {({ account, chain, openAccountModal, openConnectModal }) => (
              <Button
                type="button"
                onClick={account ? openAccountModal : openConnectModal}
                className="rounded-xs border-black bg-black text-white hover:bg-black/82"
                style={CLOUD_BUTTON_STYLE}
              >
                {account
                  ? `${account.address.slice(0, 6)}...${account.address.slice(-4)}`
                  : chain?.unsupported
                    ? t("cloud.attachWallet.wrongNetwork", {
                        defaultValue: "Wrong network",
                      })
                    : t("cloud.attachWallet.connectWallet", {
                        defaultValue: "Connect Wallet",
                      })}
              </Button>
            )}
          </ConnectButton.Custom>

          <Button
            type="button"
            onClick={handleAttach}
            disabled={!isConnected || !address || busy}
            className="min-w-[172px] rounded-xs bg-black text-white hover:bg-black/82"
            style={CLOUD_BUTTON_STYLE}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            {t("cloud.attachWallet.verifyWallet", {
              defaultValue: "Verify wallet",
            })}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
