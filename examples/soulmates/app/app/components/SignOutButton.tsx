"use client";

import { signOut } from "next-auth/react";
import { useCallback, useState } from "react";
import styles from "./SignOutButton.module.css";

type SignOutButtonProps = {
  authEnabled: boolean;
};

type DevLogoutResponse = { ok: true } | { ok: false; error: string };

export default function SignOutButton({ authEnabled }: SignOutButtonProps) {
  const [isBusy, setIsBusy] = useState(false);

  const handleSignOut = useCallback(async () => {
    if (authEnabled) {
      await signOut({ callbackUrl: "/" });
      return;
    }

    setIsBusy(true);
    try {
      const response = await fetch("/api/dev-auth/logout", { method: "POST" });
      const payload = (await response.json()) as DevLogoutResponse;
      if (!payload.ok) {
        throw new Error(payload.error);
      }
      window.location.assign("/");
    } catch {
      window.location.assign("/");
    } finally {
      setIsBusy(false);
    }
  }, [authEnabled]);

  return (
    <button
      type="button"
      className={styles.button}
      onClick={handleSignOut}
      disabled={isBusy}
    >
      {isBusy ? "Signing out..." : "Sign out"}
    </button>
  );
}
