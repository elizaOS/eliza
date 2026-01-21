"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useMemo,
  useState,
} from "react";

const ORI_PHONE_NUMBER = process.env.NEXT_PUBLIC_ORI_PHONE_NUMBER ?? "";
const ORI_PHONE_LINK = ORI_PHONE_NUMBER.replace(/[^0-9+]/g, "");

function buildSmsLink(message: string): string {
  if (!ORI_PHONE_LINK) {
    return "";
  }
  if (!message) {
    return `sms:${ORI_PHONE_LINK}`;
  }
  const encodedMessage = encodeURIComponent(message);
  return `sms:${ORI_PHONE_LINK}?&body=${encodedMessage}`;
}

function buildQrLink(name: string, location: string): string {
  const params = new URLSearchParams();
  if (name) {
    params.set("name", name);
  }
  if (location) {
    params.set("location", location);
  }
  const query = params.toString();
  return query ? `/qr?${query}` : "/qr";
}

function BlobLoadingFallback() {
  return (
    <div className="flex h-full min-h-[320px] w-full items-center justify-center">
      {/* Subtle transparent placeholder while 3D loads */}
      <div className="h-48 w-48 rounded-full bg-gradient-radial from-red-900/10 to-transparent opacity-50" />
    </div>
  );
}

// Dynamically load the 3D component with SSR disabled
const OriBlob = dynamic(() => import("../components/OriBlob"), {
  ssr: false,
  loading: () => <BlobLoadingFallback />,
});

export default function OriPage() {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const router = useRouter();

  const trimmedName = name.trim();
  const trimmedLocation = location.trim();
  const isReady = trimmedName.length > 0 && trimmedLocation.length > 0;

  const readyMessage = useMemo(() => {
    if (!isReady) {
      return "";
    }
    return `Hi Ori, I'm ${trimmedName} from ${trimmedLocation}, nice to meet you!`;
  }, [isReady, trimmedName, trimmedLocation]);

  const smsLink = useMemo(() => buildSmsLink(readyMessage), [readyMessage]);
  const qrLink = useMemo(
    () => buildQrLink(trimmedName, trimmedLocation),
    [trimmedName, trimmedLocation],
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!isReady) {
        return;
      }

      const userAgent = navigator.userAgent;
      const touchPoints = navigator.maxTouchPoints ?? 0;
      const isIOS =
        /iPad|iPhone|iPod/.test(userAgent) ||
        (userAgent.includes("Macintosh") && touchPoints > 1);
      const isMac = userAgent.includes("Macintosh") && !isIOS;
      const isApple = isIOS || isMac;

      if (!isApple) {
        router.push(qrLink);
        return;
      }

      if (isMac) {
        window.location.assign(smsLink);
        return;
      }

      let fallbackTimer: number | null = null;
      let cleanedUp = false;

      const handleVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          cleanup();
        }
      };

      const cleanup = () => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        if (fallbackTimer !== null) {
          window.clearTimeout(fallbackTimer);
        }
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
        window.removeEventListener("pagehide", handleVisibilityChange);
      };

      document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("pagehide", handleVisibilityChange);

      fallbackTimer = window.setTimeout(() => {
        cleanup();
        router.push(qrLink);
      }, 900);

      window.location.assign(smsLink);
    },
    [isReady, qrLink, router, smsLink],
  );

  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setName(event.target.value);
    },
    [],
  );

  const handleLocationChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setLocation(event.target.value);
    },
    [],
  );

  return (
    <div className="min-h-screen bg-[#120808] px-4 pb-12 pt-6 text-[var(--text-primary)]">
      <header className="mx-auto flex w-full max-w-[1100px] items-center justify-between gap-4">
        <div className="text-base font-semibold uppercase tracking-[0.2em]">
          SoulMates
        </div>
        <Link
          className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          href="/login"
        >
          Sign in
        </Link>
      </header>

      <main className="mx-auto mt-4 w-full max-w-[1100px] sm:mt-6">
        <section className="grid grid-cols-1 items-center gap-6 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)] sm:gap-8">
          <div className="grid gap-2 max-w-[340px]">
            <h1 className="text-[clamp(2rem,3.5vw,2.8rem)] font-semibold tracking-[-0.02em]">
              Meet Ori.
            </h1>
            <p className="text-[0.95rem] text-[var(--text-secondary)]">
              Whether it's business, friendship, or romance, I'm going to help
              you find it.
            </p>

            <form className="mt-3 grid gap-3" onSubmit={handleSubmit}>
              <div className="grid gap-1">
                <label
                  htmlFor="name"
                  className="text-sm text-[var(--text-secondary)]"
                >
                  Name
                </label>
                <input
                  id="name"
                  className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[0.9rem] text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus-visible:border-red-400 focus-visible:ring-4 focus-visible:ring-red-500/20"
                  type="text"
                  value={name}
                  onChange={handleNameChange}
                  autoComplete="name"
                />
              </div>

              <div className="grid gap-1">
                <label
                  htmlFor="location"
                  className="text-sm text-[var(--text-secondary)]"
                >
                  Location
                </label>
                <input
                  id="location"
                  className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[0.9rem] text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus-visible:border-red-400 focus-visible:ring-4 focus-visible:ring-red-500/20"
                  type="text"
                  value={location}
                  onChange={handleLocationChange}
                  autoComplete="address-level2"
                />
              </div>

              <button
                type="submit"
                className="w-full rounded-xl bg-gradient-to-br from-red-600 to-red-700 px-5 py-2.5 text-[0.9rem] font-semibold text-white shadow-[0_12px_32px_rgba(180,30,30,0.3)] transition hover:-translate-y-[1px] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-500/30 disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
                disabled={!isReady}
              >
                Connect
              </button>
            </form>
            <p className="text-xs text-[var(--text-muted)]">
              Already invited?{" "}
              <Link
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                href="/login"
              >
                Sign in
              </Link>
            </p>
          </div>

          <div className="order-first grid place-items-center sm:order-none">
            <div className="aspect-square w-full max-w-[380px] sm:max-w-[480px]">
              <OriBlob className="h-full w-full" />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
