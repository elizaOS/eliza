"use client";

import { logger } from "@polyagent/shared";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Key,
  LogOut,
  Shield,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";

/**
 * Security tab component for managing account security settings.
 *
 * Provides settings for managing connected wallets, authentication methods,
 * and account security. Displays wallet information, allows wallet linking/unlinking,
 * and provides logout functionality. Shows Privy authentication details.
 *
 * Features:
 * - Wallet management (link/unlink)
 * - Wallet export (for embedded wallets)
 * - Authentication method display
 * - Logout functionality
 * - Copy to clipboard utilities
 *
 * @returns Security tab element
 */
export function SecurityTab() {
  const {
    user: privyUser,
    linkWallet,
    unlinkWallet,
    exportWallet,
  } = usePrivy();
  const { wallets } = useWallets();
  const { user, logout } = useAuth();

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  const handleLogout = async () => {
    await logout();
    toast.success("Logged out successfully");
    logger.info(
      "User logged out from security settings",
      undefined,
      "SecurityTab",
    );
  };

  const getWalletTypeDisplay = (walletClientType: string) => {
    switch (walletClientType) {
      case "privy":
      case "privy-v2":
        return "Embedded Wallet";
      case "metamask":
        return "MetaMask";
      case "coinbase_wallet":
        return "Coinbase Wallet";
      case "rainbow":
        return "Rainbow";
      case "rabby_wallet":
        return "Rabby";
      default:
        return "External Wallet";
    }
  };

  const isEmbeddedWallet = (walletClientType: string) => {
    return walletClientType === "privy" || walletClientType === "privy-v2";
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h2 className="flex items-center gap-2 font-bold text-2xl">
          <Shield className="h-6 w-6 text-[#0066FF]" />
          Security Settings
        </h2>
        <p className="text-muted-foreground text-sm">
          Manage your account security, connected wallets, and authentication
          methods.
        </p>
      </div>

      {/* Authentication Info */}
      <div className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 text-green-500" />
          <div className="flex-1">
            <h3 className="font-semibold">Account Security</h3>
            <p className="mt-1 text-muted-foreground text-sm">
              Your account is secured with <strong>Privy authentication</strong>
              , providing secure wallet-based and social login options.
            </p>
            {privyUser && (
              <div className="mt-3 space-y-2">
                <div className="text-sm">
                  <span className="text-muted-foreground">User ID: </span>
                  <code className="rounded bg-muted px-2 py-1 text-xs">
                    {privyUser.id}
                  </code>
                </div>
                {privyUser.email && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Email: </span>
                    <span className="font-medium">
                      {privyUser.email.address}
                    </span>
                  </div>
                )}
                {privyUser.farcaster && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Farcaster: </span>
                    <span className="font-medium">
                      @{privyUser.farcaster.username}
                    </span>
                  </div>
                )}
                {privyUser.twitter && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">X: </span>
                    <span className="font-medium">
                      @{privyUser.twitter.username}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Connected Wallets */}
      <div className="space-y-4 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 font-semibold">
              <Wallet className="h-4 w-4" />
              Connected Wallets
            </h3>
            <p className="mt-1 text-muted-foreground text-sm">
              Manage your blockchain wallets and authentication methods
            </p>
          </div>
          {linkWallet && (
            <button
              onClick={linkWallet}
              className="rounded-lg bg-[#0066FF] px-4 py-2 font-medium text-primary-foreground text-sm hover:bg-[#0066FF]/90"
            >
              Link Wallet
            </button>
          )}
        </div>

        {wallets.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            <Wallet className="mx-auto mb-3 h-12 w-12 opacity-50" />
            <p className="text-sm">No wallets connected</p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {wallets.map((wallet) => (
              <div
                key={wallet.address}
                className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-muted p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm">
                      {getWalletTypeDisplay(wallet.walletClientType)}
                    </span>
                    {isEmbeddedWallet(wallet.walletClientType) && (
                      <span className="rounded bg-[#0066FF]/20 px-2 py-0.5 text-[#0066FF] text-xs">
                        Embedded
                      </span>
                    )}
                    {wallet.address === user?.walletAddress && (
                      <span className="rounded bg-green-500/20 px-2 py-0.5 text-green-500 text-xs">
                        Primary
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="text-muted-foreground text-xs">
                      {wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}
                    </code>
                    <button
                      onClick={() => copyToClipboard(wallet.address, "Address")}
                      className="rounded p-1 hover:bg-background"
                      title="Copy full address"
                    >
                      <Copy className="h-3 w-3 text-muted-foreground" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isEmbeddedWallet(wallet.walletClientType) &&
                    exportWallet && (
                      <button
                        onClick={exportWallet}
                        className="flex items-center gap-1 rounded border border-border bg-background px-3 py-1.5 font-medium text-xs hover:bg-accent"
                        title="Export wallet private key"
                      >
                        <Key className="h-3 w-3" />
                        <span className="hidden sm:inline">Export</span>
                      </button>
                    )}
                  {wallets.length > 1 && unlinkWallet && (
                    <button
                      onClick={() => unlinkWallet(wallet.address)}
                      className="rounded px-3 py-1.5 font-medium text-red-500 text-xs hover:bg-red-500/10"
                    >
                      Unlink
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
            <div className="text-muted-foreground text-sm">
              <strong className="text-foreground">Embedded wallets</strong> are
              created and managed by Privy, enabling gasless transactions. You
              can export your private key at any time.{" "}
              <strong className="text-foreground">External wallets</strong>{" "}
              require you to pay gas fees.
            </div>
          </div>
        </div>
      </div>

      {/* Session Management */}
      <div className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <LogOut className="mt-0.5 h-5 w-5 text-[#0066FF]" />
          <div className="flex-1">
            <h3 className="font-semibold">Active Session</h3>
            <p className="mt-1 text-muted-foreground text-sm">
              You are currently logged in. Log out to end your session and clear
              authentication.
            </p>
            <button
              onClick={handleLogout}
              className="mt-3 rounded-lg bg-muted px-4 py-2 font-medium text-foreground text-sm hover:bg-muted/80"
            >
              Log Out
            </button>
          </div>
        </div>
      </div>

      {/* Additional Resources */}
      <div className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="font-semibold">Security Resources</h3>
        <div className="space-y-2">
          <a
            href="https://docs.privy.io/guide/security"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-[#0066FF] text-sm hover:underline"
          >
            <ExternalLink className="h-4 w-4" />
            Privy Security Documentation
          </a>
          <a
            href="https://docs.polyagent.app/security"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-[#0066FF] text-sm hover:underline"
          >
            <ExternalLink className="h-4 w-4" />
            Polyagent Security Best Practices
          </a>
        </div>
        <p className="mt-3 text-muted-foreground text-xs">
          For security concerns or to report vulnerabilities, contact{" "}
          <a
            href="mailto:security@elizas.com"
            className="text-[#0066FF] hover:underline"
          >
            security@elizas.com
          </a>
        </p>
      </div>

      {/* Privacy & Account Deletion Link */}
      <div className="space-y-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-5 w-5 text-yellow-500" />
          <div className="flex-1">
            <h3 className="font-semibold text-yellow-500">
              Account Privacy & Deletion
            </h3>
            <p className="mt-1 text-muted-foreground text-sm">
              To export your data or permanently delete your account, visit the
              Privacy tab.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
