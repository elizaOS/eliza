"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  CREDIT_PACKS,
  CREDIT_SPEND_OPTIONS,
  type CreditPack,
  type CreditSpendOption,
} from "@/lib/credits";
import type { ApiResponse, CreditLedgerEntry, ProfileData } from "@/types/api";
import styles from "./page.module.css";

export default function BillingPage() {
  const searchParams = useSearchParams();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<CreditPack | null>(
    null,
  );
  const [spendLoading, setSpendLoading] = useState<CreditSpendOption | null>(
    null,
  );
  const [ledger, setLedger] = useState<CreditLedgerEntry[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const status = searchParams?.get("success")
      ? "Payment received. Credits will update shortly."
      : searchParams?.get("canceled")
        ? "Checkout canceled."
        : null;
    setMessage(status);
  }, [searchParams]);

  useEffect(() => {
    const load = async () => {
      setPageLoading(true);
      try {
        const [profileRes, ledgerRes] = await Promise.all([
          fetch("/api/profile"),
          fetch("/api/billing/ledger"),
        ]);
        const payload = (await profileRes.json()) as ApiResponse<ProfileData>;
        const ledgerPayload = (await ledgerRes.json()) as ApiResponse<
          CreditLedgerEntry[]
        >;
        if (!payload.ok) {
          setError(payload.error);
          return;
        }
        if (!ledgerPayload.ok) {
          setError(ledgerPayload.error);
          return;
        }
        setProfile(payload.data);
        setLedger(ledgerPayload.data);
      } catch {
        setError("Unable to load credits.");
      } finally {
        setPageLoading(false);
      }
    };
    load();
  }, []);

  const handleCheckout = useCallback(
    async (pack: CreditPack) => {
      if (profile?.status === "blocked") {
        setError("Your account is blocked from making purchases.");
        return;
      }
      setCheckoutLoading(pack);
      setError(null);
      try {
        const response = await fetch("/api/billing/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ packId: pack.id }),
        });
        const payload = (await response.json()) as ApiResponse<{ url: string }>;
        if (!payload.ok) {
          setError(payload.error);
          setCheckoutLoading(null);
          return;
        }
        window.location.assign(payload.data.url);
      } catch {
        setError("Unable to start checkout.");
        setCheckoutLoading(null);
      }
    },
    [profile?.status],
  );

  const handleSpend = useCallback(
    async (option: CreditSpendOption) => {
      if (profile?.status === "blocked") {
        setError("Your account is blocked from spending credits.");
        return;
      }
      setSpendLoading(option);
      setError(null);
      try {
        const response = await fetch("/api/billing/spend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ optionId: option.id }),
        });
        const payload = (await response.json()) as ApiResponse<ProfileData>;
        if (!payload.ok) {
          setError(payload.error);
          setSpendLoading(null);
          return;
        }
        setProfile(payload.data);
        const ledgerRes = await fetch("/api/billing/ledger");
        const ledgerPayload = (await ledgerRes.json()) as ApiResponse<
          CreditLedgerEntry[]
        >;
        if (ledgerPayload.ok) {
          setLedger(ledgerPayload.data);
        }
        setMessage(
          `Used ${option.cost} credits for ${option.label.toLowerCase()}.`,
        );
      } catch {
        setError("Unable to spend credits.");
      } finally {
        setSpendLoading(null);
      }
    },
    [profile?.status],
  );

  if (pageLoading) {
    return (
      <div className={styles.page}>
        <header className={styles.header}>
          <h1>Credits</h1>
          <p>Top up to access premium matching and scheduling.</p>
        </header>
        <div className={styles.notice}>Loading billing information...</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Credits</h1>
        <p>Top up to access premium matching and scheduling.</p>
      </header>

      <section className={styles.balance}>
        <div>
          <h2>Balance</h2>
          <p className={styles.balanceValue}>{profile?.credits ?? 0} credits</p>
        </div>
        <div className={styles.balanceMeta}>
          <p>Status: {profile?.status ?? "..."}</p>
          <p>Phone: {profile?.phone ?? "..."}</p>
        </div>
      </section>

      {message ? <div className={styles.notice}>{message}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}

      <section className={styles.grid}>
        {CREDIT_PACKS.map((pack) => (
          <div key={pack.id} className={styles.card}>
            <div>
              <h3>{pack.credits} credits</h3>
              <p>{pack.description}</p>
            </div>
            <button
              type="button"
              className={styles.primary}
              onClick={() => handleCheckout(pack)}
              disabled={checkoutLoading?.id === pack.id}
            >
              {checkoutLoading?.id === pack.id
                ? "Redirecting..."
                : `Buy ${pack.label}`}
            </button>
          </div>
        ))}
      </section>

      <section className={styles.grid}>
        {CREDIT_SPEND_OPTIONS.map((option) => (
          <div key={option.id} className={styles.card}>
            <div>
              <h3>{option.label}</h3>
              <p>{option.description}</p>
              <p className={styles.muted}>Cost: {option.cost} credits</p>
            </div>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => handleSpend(option)}
              disabled={spendLoading?.id === option.id}
            >
              {spendLoading?.id === option.id
                ? "Processing..."
                : "Spend credits"}
            </button>
          </div>
        ))}
      </section>

      <section className={styles.ledger}>
        <h2>Ledger</h2>
        <div className={styles.ledgerList}>
          {ledger.map((entry) => (
            <div key={entry.id} className={styles.ledgerRow}>
              <div>
                <p className={styles.ledgerReason}>{entry.reason}</p>
                <p className={styles.muted}>
                  {new Date(entry.createdAt).toLocaleString()} · Ref{" "}
                  {entry.reference ?? "n/a"}
                </p>
              </div>
              <div className={styles.ledgerDelta}>
                {entry.delta > 0 ? `+${entry.delta}` : entry.delta} →{" "}
                {entry.balance}
              </div>
            </div>
          ))}
          {ledger.length === 0 ? (
            <p className={styles.muted}>No ledger entries yet.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
