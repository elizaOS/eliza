import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth.js";
import type { StewardUserButtonProps } from "../types.js";

/**
 * Compute an MD5-like hash for Gravatar URLs.
 * Uses a simple string hash since we only need it for avatar lookup,
 * not cryptographic security. Falls back to the "identicon" default.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  // Convert to a hex-like string, zero-padded to 32 chars for Gravatar
  const hex = Math.abs(hash).toString(16);
  return hex.padStart(32, "0");
}

function getGravatarUrl(email: string, size: number): string {
  const hash = simpleHash(email.trim().toLowerCase());
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=identicon`;
}

function getInitials(email: string): string {
  const local = email.split("@")[0] ?? "";
  if (!local) return "?";
  return local.charAt(0).toUpperCase();
}

function truncateAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * StewardUserButton — Shows the authenticated user with a sign-out dropdown.
 *
 * Displays user email or truncated wallet address. Click toggles a dropdown.
 * Clicking outside the dropdown closes it.
 *
 * @example
 * <StewardUserButton onSignOut={() => router.push("/login")} />
 */
export function StewardUserButton({
  className,
  onSignOut,
  showWallet = false,
  avatarSize = 32,
  showTenantSwitcher = false,
}: StewardUserButtonProps) {
  const auth = useAuth();
  const { signOut, session } = auth;
  // Prefer auth.user, but fall back to session fields (user is null on refresh)
  const user =
    auth.user ??
    (session
      ? {
          id: session.userId ?? session.address ?? "",
          email: session.email ?? "",
          walletAddress: session.address || undefined,
        }
      : null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open, handleClickOutside]);

  if (!user) return null;

  const displayEmail = user.email || null;
  const displayWallet = user.walletAddress ? truncateAddress(user.walletAddress) : null;
  const displayName = displayEmail ?? displayWallet ?? "User";

  const handleSignOut = () => {
    setOpen(false);
    signOut();
    onSignOut?.();
  };

  return (
    <div className={`stwd-user-button ${className ?? ""}`} ref={containerRef}>
      <button
        className="stwd-user-button__trigger"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
      >
        {displayEmail ? (
          <img
            className="stwd-user-button__avatar"
            src={getGravatarUrl(displayEmail, avatarSize * 2)}
            alt=""
            width={avatarSize}
            height={avatarSize}
            onError={(e) => {
              // Hide broken image, initials circle will show via CSS
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <span
            className="stwd-user-button__avatar stwd-user-button__avatar--initials"
            style={{
              width: avatarSize,
              height: avatarSize,
              fontSize: avatarSize * 0.45,
            }}
          >
            {getInitials(displayName)}
          </span>
        )}
        <span className="stwd-user-button__name">
          {displayEmail ?? (showWallet && displayWallet ? displayWallet : displayName)}
        </span>
      </button>

      {open && (
        <div className="stwd-user-button__dropdown" role="menu">
          {displayEmail && showWallet && displayWallet && (
            <div className="stwd-user-button__dropdown-info" role="presentation">
              {displayWallet}
            </div>
          )}
          {/* Current tenant info */}
          {auth.activeTenantId &&
            auth.tenants &&
            (() => {
              const current = auth.tenants.find((t) => t.tenantId === auth.activeTenantId);
              return current ? (
                <div className="stwd-user-button__dropdown-tenant" role="presentation">
                  <span className="stwd-user-button__tenant-label">App:</span>{" "}
                  <span className="stwd-user-button__tenant-name">{current.tenantName}</span>
                </div>
              ) : null;
            })()}
          {/* Inline tenant switcher */}
          {showTenantSwitcher && auth.tenants && auth.tenants.length > 1 && (
            <div className="stwd-user-button__tenant-switcher">
              <div className="stwd-user-button__tenant-switcher-label">Switch App</div>
              {auth.tenants
                .filter((t) => t.tenantId !== auth.activeTenantId)
                .map((tenant) => (
                  <button
                    key={tenant.tenantId}
                    className="stwd-user-button__dropdown-item stwd-user-button__dropdown-item--tenant"
                    onClick={() => {
                      void auth.switchTenant(tenant.tenantId).then((ok) => {
                        if (ok) setOpen(false);
                      });
                    }}
                    type="button"
                    role="menuitem"
                    disabled={auth.isLoading}
                  >
                    {tenant.tenantName}
                  </button>
                ))}
            </div>
          )}
          <button
            className="stwd-user-button__dropdown-item stwd-user-button__dropdown-item--signout"
            onClick={handleSignOut}
            type="button"
            role="menuitem"
          >
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}
