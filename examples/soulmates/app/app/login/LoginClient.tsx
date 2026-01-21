"use client";

import Link from "next/link";
import { type SignInResponse, signIn } from "next-auth/react";
import { useCallback, useState } from "react";
import styles from "./page.module.css";

type SmsResponse = { ok: true } | { ok: false; error: string };

type DevLoginResponse =
  | { ok: true; userId: string }
  | { ok: false; error: string };

type LoginClientProps = {
  authEnabled: boolean;
  devLoginEnabled: boolean;
};

export default function LoginClient({
  authEnabled,
  devLoginEnabled,
}: LoginClientProps) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendCode = useCallback(async () => {
    if (!authEnabled) {
      setError("SMS sign-in is unavailable in local dev.");
      return;
    }
    setSending(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/auth/sms/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const payload = (await response.json()) as SmsResponse;
      if (!payload.ok) {
        setError(payload.error);
        return;
      }
      setMessage("Verification code sent.");
    } catch {
      setError("Unable to send code.");
    } finally {
      setSending(false);
    }
  }, [authEnabled, phone]);

  const handleSignIn = useCallback(async () => {
    if (!authEnabled) {
      setError("Sign-in is unavailable in local dev.");
      return;
    }
    setVerifying(true);
    setError(null);
    const result: SignInResponse | undefined = await signIn("credentials", {
      phone,
      code,
      redirect: false,
      callbackUrl: "/app",
    });
    if (result?.error) {
      setError("Invalid code.");
      setVerifying(false);
      return;
    }
    if (result?.url) {
      window.location.assign(result.url);
      return;
    }
    setVerifying(false);
  }, [authEnabled, code, phone]);

  const handleDevLogin = useCallback(async () => {
    setVerifying(true);
    setError(null);

    if (authEnabled) {
      const result: SignInResponse | undefined = await signIn("credentials", {
        devLogin: "true",
        redirect: false,
        callbackUrl: "/app",
      });
      if (result?.error) {
        setError("Dev login unavailable.");
        setVerifying(false);
        return;
      }
      if (result?.url) {
        window.location.assign(result.url);
        return;
      }
      setVerifying(false);
      return;
    }

    try {
      const response = await fetch("/api/dev-auth/login", { method: "POST" });
      const payload = (await response.json()) as DevLoginResponse;
      if (!payload.ok) {
        setError(payload.error);
        setVerifying(false);
        return;
      }
      window.location.assign("/app");
    } catch {
      setError("Dev login unavailable.");
      setVerifying(false);
    }
  }, [authEnabled]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          Soulmates
        </Link>
        <Link href="/" className={styles.back}>
          Back to landing
        </Link>
      </header>

      <main className={styles.main}>
        <section className={styles.card}>
          <h1>Sign in</h1>
          <p>Use your phone number to continue.</p>

          {!authEnabled ? (
            <p className={styles.notice}>
              Local dev mode is active. Use dev login to continue.
            </p>
          ) : null}

          <label className={styles.field}>
            <span>Phone</span>
            <input
              type="tel"
              placeholder="+15551234567"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              disabled={!authEnabled}
            />
          </label>

          <button
            type="button"
            className={styles.secondary}
            onClick={sendCode}
            disabled={!authEnabled || sending || phone.trim().length === 0}
          >
            {sending ? "Sending..." : "Send code"}
          </button>

          <label className={styles.field}>
            <span>Verification code</span>
            <input
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={!authEnabled}
            />
          </label>

          <button
            type="button"
            className={styles.primary}
            onClick={handleSignIn}
            disabled={!authEnabled || verifying || code.trim().length === 0}
          >
            {verifying ? "Signing in..." : "Sign in"}
          </button>

          {devLoginEnabled ? (
            <button
              type="button"
              className={styles.dev}
              onClick={handleDevLogin}
              disabled={verifying}
            >
              Dev login
            </button>
          ) : null}

          {message ? <p className={styles.notice}>{message}</p> : null}
          {error ? <p className={styles.error}>{error}</p> : null}
        </section>
      </main>
    </div>
  );
}
