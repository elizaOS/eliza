/**
 * Authenticated contributor payout editor that produces the profile-README
 * marker used by the rewards pipeline without collecting wallet secrets.
 */

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { Check, Copy, Loader2, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/context/auth-context";
import {
  generateWalletReadmeComment,
  isValidEthereumAddress,
  isValidSolanaAddress,
} from "@/lib/wallet-linking";

export default function ProfileEditPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useAuth();
  const [ethereum, setEthereum] = useState("");
  const [solana, setSolana] = useState("");
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate("/login?returnTo=%2Fprofile%2Fedit", { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate]);

  function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEthereum = ethereum.trim();
    const normalizedSolana = solana.trim();

    if (!normalizedEthereum && !normalizedSolana) {
      setError("Add at least one public wallet address.");
      return;
    }
    if (normalizedEthereum && !isValidEthereumAddress(normalizedEthereum)) {
      setError("Enter a valid EVM address beginning with 0x.");
      return;
    }
    if (normalizedSolana && !isValidSolanaAddress(normalizedSolana)) {
      setError("Enter a valid Solana address.");
      return;
    }

    setError("");
    setCopied(false);
    setComment(
      generateWalletReadmeComment({
        ethereum: normalizedEthereum || undefined,
        solana: normalizedSolana || undefined,
      }),
    );
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(comment);
      setError("");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // error-policy:J4 Clipboard denial is surfaced as a visible form error.
      setCopied(false);
      setError("Copy failed. Select the marker and copy it manually.");
    }
  }

  if (isLoading || !isAuthenticated) {
    return (
      <main className="theme-app profile-edit-loading" aria-live="polite">
        <Loader2 className="size-8 animate-spin" />
        <h1>Opening payout profile…</h1>
        <p>Sign in is required. We’ll bring you back here afterward.</p>
      </main>
    );
  }

  return (
    <main className="theme-app profile-edit-page">
      <header className="profile-edit-header">
        <a href="/" aria-label="Eliza home">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaBlack}`}
            alt="Eliza"
            width={269}
            height={99}
            className="app-brand-mark"
          />
        </a>
        <span>Payout profile</span>
      </header>

      <section className="profile-edit-layout">
        <div className="profile-edit-intro">
          <p className="app-eyebrow">Contributor payments</p>
          <h1>Link a public wallet.</h1>
          <p>
            Generate the hidden marker Eliza uses to discover your payout
            address from your GitHub profile README.
          </p>
          <div className="profile-edit-safety">
            <ShieldCheck aria-hidden="true" />
            <p>
              Public receiving addresses only. Never enter a private key or seed
              phrase.
            </p>
          </div>
        </div>

        <form className="profile-edit-card" onSubmit={handleGenerate}>
          <label htmlFor="ethereum-address">Ethereum / EVM address</label>
          <input
            id="ethereum-address"
            value={ethereum}
            onChange={(event) => setEthereum(event.target.value)}
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
          />

          <div className="profile-edit-divider">
            <span>or add both</span>
          </div>

          <label htmlFor="solana-address">Solana address</label>
          <input
            id="solana-address"
            value={solana}
            onChange={(event) => setSolana(event.target.value)}
            placeholder="Base58 public address"
            autoComplete="off"
            spellCheck={false}
          />

          {error && (
            <p className="profile-edit-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="profile-edit-primary">
            Generate README marker
          </button>

          {comment && (
            <section className="profile-edit-result" aria-live="polite">
              <div>
                <h2>Ready to add to GitHub</h2>
                <p>
                  Paste this anywhere in your GitHub profile repository’s
                  README.md. It stays hidden on the rendered profile.
                </p>
              </div>
              <textarea
                aria-label="Generated wallet linking comment"
                value={comment}
                readOnly
                rows={11}
              />
              <button
                type="button"
                className="profile-edit-copy"
                onClick={handleCopy}
              >
                {copied ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy hidden comment"}
              </button>
            </section>
          )}
        </form>
      </section>
    </main>
  );
}
