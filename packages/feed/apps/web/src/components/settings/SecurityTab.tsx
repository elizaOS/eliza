'use client';

import { ExternalLink } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';

/**
 * Security tab for account security settings.
 *
 * Phase 2: Wallet management removed (Privy embedded wallets deprecated).
 * Displays authenticated session info from Steward.
 */
export function SecurityTab() {
  const { user } = useAuthStore();
  const { logout } = useAuth();

  return (
    <div className="space-y-6">
      {/* Account Info */}
      <div className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="font-semibold">Account Security</h3>
        {user && (
          <div className="mt-3 space-y-2">
            {user.email && (
              <div className="text-sm">
                <span className="text-muted-foreground">Email: </span>
                <span className="font-medium">{user.email}</span>
              </div>
            )}
            {user.farcasterUsername && (
              <div className="text-sm">
                <span className="text-muted-foreground">Farcaster: </span>
                <span className="font-medium">@{user.farcasterUsername}</span>
              </div>
            )}
            {user.twitterUsername && (
              <div className="text-sm">
                <span className="text-muted-foreground">X / Twitter: </span>
                <span className="font-medium">@{user.twitterUsername}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Security Resources */}
      <div className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="font-semibold">Security Resources</h3>
        <div className="mt-1 space-y-2">
          <a
            href="https://docs.feed.market/security"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-[#0066FF] text-sm hover:underline"
          >
            <ExternalLink className="h-4 w-4" />
            Feed Security Best Practices
          </a>
        </div>
        <p className="mt-3 text-muted-foreground text-xs">
          For security concerns or to report vulnerabilities, contact{' '}
          <a
            href="mailto:feed@elizalabs.ai"
            className="text-[#0066FF] hover:underline"
          >
            feed@elizalabs.ai
          </a>
        </p>
      </div>

      {/* Sign out */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="font-semibold">Session</h3>
        <p className="mt-1 text-muted-foreground text-sm">
          Signing out will end your current session on this device.
        </p>
        <button
          type="button"
          onClick={() => void logout()}
          className="mt-3 rounded-lg border border-red-500/30 px-4 py-2 font-medium text-red-500 text-sm hover:bg-red-500/10"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
