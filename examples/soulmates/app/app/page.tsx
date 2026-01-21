"use client";

import Image from "next/image";
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

export default function Home() {
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

      if (!smsLink) {
        router.push(qrLink);
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

      let fallbackTimer: number | null = null;
      let cleanedUp = false;

      const handleVisibilityChange = (event?: Event) => {
        if (event?.type === "blur" || document.visibilityState === "hidden") {
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
        window.removeEventListener("blur", handleVisibilityChange);
      };

      document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("pagehide", handleVisibilityChange);
      window.addEventListener("blur", handleVisibilityChange);

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
    <div className="min-h-screen bg-[var(--bg-primary)] px-6 pb-[72px] pt-8 text-[var(--text-primary)]">
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

      <main className="mx-auto mt-8 w-full max-w-[1100px] sm:mt-12">
        <section className="grid grid-cols-1 items-center gap-12 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
          <div className="grid gap-2.5">
            <h1 className="text-[clamp(2.4rem,4.2vw,3.6rem)] font-semibold tracking-[-0.02em]">
              Meet Ori.
            </h1>
            <p className="text-[1.05rem] text-[var(--text-secondary)]">
              Whether it's business, friendship, or romance, I'm going to help
              you find it.
            </p>

            <form className="mt-5 grid gap-4" onSubmit={handleSubmit}>
              <div className="grid gap-1.5">
                <label
                  htmlFor="name"
                  className="text-sm text-[var(--text-secondary)]"
                >
                  Name
                </label>
                <input
                  id="name"
                  className="w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-4 py-3.5 text-[0.95rem] text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus-visible:border-fuchsia-400 focus-visible:ring-4 focus-visible:ring-fuchsia-500/20"
                  type="text"
                  value={name}
                  onChange={handleNameChange}
                  autoComplete="name"
                />
              </div>

              <div className="grid gap-1.5">
                <label
                  htmlFor="location"
                  className="text-sm text-[var(--text-secondary)]"
                >
                  Location
                </label>
                <input
                  id="location"
                  className="w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-4 py-3.5 text-[0.95rem] text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus-visible:border-fuchsia-400 focus-visible:ring-4 focus-visible:ring-fuchsia-500/20"
                  type="text"
                  value={location}
                  onChange={handleLocationChange}
                  autoComplete="address-level2"
                />
              </div>

              <button
                type="submit"
                className="w-full rounded-[14px] bg-gradient-to-br from-fuchsia-500 to-pink-500 px-6 py-3.5 text-base font-semibold text-white shadow-[0_16px_40px_rgba(168,85,247,0.2)] transition hover:-translate-y-[1px] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-fuchsia-500/30 disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none sm:w-auto"
                disabled={!isReady}
              >
                Connect
              </button>
            </form>
            <p className="text-sm text-[var(--text-muted)]">
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
            <Image
              className="h-auto w-full max-w-[320px] rounded-[22px] border border-[var(--border-color)] bg-[var(--bg-tertiary)] shadow-[0_30px_80px_rgba(0,0,0,0.35)] sm:max-w-[360px]"
              src="/ori.png"
              alt="Ori, SoulMates matchmaker"
              width={360}
              height={360}
            />
          </div>
        </section>
      </main>
    </div>
  );
}
