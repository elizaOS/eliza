/**
 * eliza.app landing page: a single-viewport, personal-feeling lander.
 *
 * The first action opens a real iMessage thread; account and app setup stay out
 * of the way until someone wants the richer companion experience. The phone
 * demo stays within the immediately available product: conversation memory and
 * current web search. It is decorative and intentionally English-only.
 * Reduced motion shows its settled intro, which keeps screenshots deterministic.
 */

import { IMessageIcon } from "@elizaos/ui/cloud-ui/components/icons";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
// Imported through the bundler (not referenced from public/) so the wordmark
// ships with whichever build consumes this source; a public/ path depends on
// the host app's asset-sync allowlist and 404s when it drifts.
import elizaLogotextUrl from "@/assets/eliza-logotext.svg";
import {
  buildElizaSmsHref,
  ELIZA_PHONE_FORMATTED,
  ELIZA_PHONE_NUMBER,
} from "@/lib/contact";
import { resolveHomepageProductNavigation } from "@/lib/product-navigation";
import { useT } from "@/providers/I18nProvider";

// The ambient gradient wave stays lazy so the static hero is interactive
// before any WebGL code downloads.
const ShaderBackground = lazy(
  () => import("@/components/ShaderBackground/ShaderBackground"),
);

interface DemoCard {
  label: string;
  title: string;
  rows: string[];
  status?: string;
}

type DemoStep =
  | { kind: "eliza"; text: string }
  | { kind: "user"; text: string }
  | { kind: "card"; card: DemoCard };

type DemoItemInput =
  | { from: "eliza" | "user"; kind: "text"; text: string }
  | { from: "eliza"; kind: "card"; card: DemoCard };

type DemoItem = DemoItemInput & { id: number };

const DEMO_INTRO: DemoStep[] = [
  { kind: "eliza", text: "Hey, it's Eliza — your new assistant." },
  { kind: "user", text: "what can you do?" },
  {
    kind: "eliza",
    text: "I'm here to save you time and take things off your plate. Should we start with your email?",
  },
  { kind: "user", text: "sure" },
  {
    kind: "eliza",
    text: "Looks like you've got 2 important emails you haven't followed up on — one looks like an important work thing. Should I draft a reply?",
  },
  { kind: "user", text: "sounds great" },
  {
    kind: "eliza",
    text: "Okay, I've drafted the reply and saved it in your inbox. Want to look it over before I send it?",
  },
  {
    kind: "card",
    card: {
      label: "Mail",
      title: "Re: Q3 partnership",
      rows: ["Draft saved to your inbox"],
    },
  },
  { kind: "user", text: "yes please" },
  {
    kind: "eliza",
    text: "Sent to your inbox. Also — you've got a call in an hour with an investor. Want me to give you a ring a few minutes before so you don't forget?",
  },
  { kind: "user", text: "yes please!" },
  {
    kind: "eliza",
    text: "Will do. I've also prepared a dossier for the call — they've made some similar investments, I think you'll be a good fit.",
  },
  {
    kind: "card",
    card: {
      label: "Notes",
      title: "Investor brief — Arc Capital",
      rows: ["Recent: 3 similar investments", "2 pages"],
    },
  },
  {
    kind: "card",
    card: {
      label: "Calendar",
      title: "Call with Arc Capital",
      rows: ["Today, 2:00 PM"],
      status: "I'll call you at 1:55",
    },
  },
];

const DEMO_LOOP: DemoStep[] = [
  {
    kind: "eliza",
    text: "How did the call go? Anything else I can take off your plate today?",
  },
  {
    kind: "user",
    text: "can you book dinner for 4 on thursday? somewhere italian",
  },
  {
    kind: "eliza",
    text: "Via Carota has one table for 4 left at 7:30 on Thursday. Should I book it?",
  },
  { kind: "user", text: "book it" },
  {
    kind: "card",
    card: {
      label: "Reservation",
      title: "Via Carota",
      rows: ["Thursday, 7:30 PM", "Party of 4"],
      status: "Booked",
    },
  },
  { kind: "eliza", text: "Done. Want me to send the details to the group?" },
  { kind: "user", text: "oh and I fly to SF on friday" },
  {
    kind: "eliza",
    text: "I see it — UA 512 out of JFK, 9:15 AM. Want me to check you in when it opens and grab your usual aisle seat?",
  },
  { kind: "user", text: "yes" },
  {
    kind: "card",
    card: {
      label: "Flight",
      title: "UA 512 — JFK to SFO",
      rows: ["Friday, 9:15 AM", "Seat 14C"],
      status: "Check-in scheduled",
    },
  },
  {
    kind: "eliza",
    text: "Set. One thing — your 9 AM standup overlaps with boarding. Should I move it?",
  },
  { kind: "user", text: "good catch, yeah" },
  { kind: "user", text: "what was that wine we had at dinner last month?" },
  {
    kind: "eliza",
    text: "The 2019 Barolo from Cascina Fontana. You mentioned wanting it for your dad's birthday — that's in 12 days. Should I order a bottle?",
  },
  { kind: "user", text: "you're the best. add a card too" },
  {
    kind: "card",
    card: {
      label: "Reminders",
      title: "Dad's birthday",
      rows: ["Barolo, Cascina Fontana '19", "Birthday card"],
      status: "Reminder set",
    },
  },
  {
    kind: "eliza",
    text: "Morning. Quick brief: 3 meetings today, rain at 4 so take a jacket. Inbox is triaged — nothing urgent.",
  },
  { kind: "user", text: "what would I do without you" },
  { kind: "eliza", text: "Happy to help. What's next on your plate?" },
];

// Keep only the most recent messages in the DOM; the thread stays pinned to
// the bottom so pruning older rows is invisible.
const MAX_RENDERED_ITEMS = 14;
const USER_KEYSTROKE_MS = 62;
const ELIZA_TYPING_MS = 2275;
const BEAT_PAUSE_MS = 1465;
const PRE_USER_MS = 815;
const PRE_ELIZA_MS = 815;
const PRE_CARD_MS = 975;
const SEND_HOLD_MS = 650;

const LOCAL_CLOCK_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function localClock(date: Date, includeDayPeriod: boolean): string {
  const parts = LOCAL_CLOCK_FORMATTER.formatToParts(date);
  return parts
    .filter((part) => includeDayPeriod || part.type !== "dayPeriod")
    .map((part) => part.value)
    .join("")
    .trim();
}

function settledIntroItems(): DemoItem[] {
  return DEMO_INTRO.map((step, index) =>
    step.kind === "card"
      ? { id: index, from: "eliza", kind: "card", card: step.card }
      : { id: index, from: step.kind, kind: "text", text: step.text },
  );
}

function DemoCardBubble({ card }: { card: DemoCard }) {
  return (
    <div className="landing-demo-card">
      <span className="landing-demo-card-label">{card.label}</span>
      <strong>{card.title}</strong>
      {card.rows.map((row) => (
        <span className="landing-demo-card-row" key={row}>
          {row}
        </span>
      ))}
      {card.status ? (
        <span className="landing-demo-card-status">
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m3 8.3 3 3L13 4.7" />
          </svg>
          {card.status}
        </span>
      ) : null}
    </div>
  );
}

function PhoneMockup() {
  const t = useT();
  const [clock, setClock] = useState(() => new Date());
  const [items, setItems] = useState<DemoItem[]>([]);
  const [phase, setPhase] = useState<"intro" | "looping" | "settled">("intro");
  const [elizaTyping, setElizaTyping] = useState(false);
  const [composerText, setComposerText] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const nextIdRef = useRef(DEMO_INTRO.length);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setItems(settledIntroItems());
      setPhase("settled");
      return;
    }

    let cancelled = false;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    const append = (item: DemoItemInput) => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      setItems((prev) => [
        ...prev.slice(-(MAX_RENDERED_ITEMS - 1)),
        { ...item, id },
      ]);
    };

    const play = async (steps: DemoStep[]) => {
      for (const step of steps) {
        if (cancelled) return;
        if (step.kind === "user") {
          await sleep(PRE_USER_MS);
          for (let i = 1; i <= step.text.length; i++) {
            if (cancelled) return;
            setComposerText(step.text.slice(0, i));
            await sleep(USER_KEYSTROKE_MS);
          }
          await sleep(SEND_HOLD_MS);
          if (cancelled) return;
          setComposerText("");
          append({ from: "user", kind: "text", text: step.text });
        } else if (step.kind === "eliza") {
          await sleep(PRE_ELIZA_MS);
          if (cancelled) return;
          setElizaTyping(true);
          await sleep(ELIZA_TYPING_MS);
          if (cancelled) return;
          setElizaTyping(false);
          append({ from: "eliza", kind: "text", text: step.text });
        } else {
          await sleep(PRE_CARD_MS);
          if (cancelled) return;
          append({ from: "eliza", kind: "card", card: step.card });
        }
        await sleep(BEAT_PAUSE_MS);
      }
    };

    (async () => {
      await play(DEMO_INTRO);
      if (cancelled) return;
      setPhase("looping");
      while (!cancelled) {
        await play(DEMO_LOOP);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the thread pinned to the newest message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll reacts to content growth, not to values read inside.
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
    // composerText opens/closes the keyboard, which changes the thread's
    // height; re-pin so the newest message stays visible.
  }, [items, elizaTyping, composerText]);

  return (
    <div
      className="landing-iphone"
      aria-hidden="true"
      data-demo-phase={phase}
      data-demo-messages={items.length}
    >
      <div className="landing-iphone-screen">
        <div className="landing-phone-top">
          <div className="landing-iphone-statusbar">
            <span className="landing-iphone-time">
              {localClock(clock, false)}
            </span>
            <span className="landing-iphone-island" />
            <span className="landing-iphone-signal">
              <svg viewBox="0 0 41 12" fill="currentColor" aria-hidden="true">
                <rect x="0" y="7" width="3" height="5" rx="1" />
                <rect x="5" y="5" width="3" height="7" rx="1" />
                <rect x="10" y="3" width="3" height="9" rx="1" />
                <rect x="15" y="1" width="3" height="11" rx="1" />
                <rect
                  x="24"
                  y="1"
                  width="14"
                  height="10"
                  rx="2.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect x="25.7" y="2.7" width="10" height="6.6" rx="1.2" />
                <path
                  d="M39.2 4.1v3.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </div>
          <div className="landing-phone-header">
            <span className="landing-phone-contact">
              <img
                className="landing-phone-avatar"
                src="/brand/logos/logo_white_orangebg.svg"
                alt=""
                width={423}
                height={423}
              />
              <span className="landing-phone-name">
                Eliza
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </span>
            </span>
          </div>
        </div>
        <div className="landing-phone-thread" ref={threadRef}>
          <div className="landing-thread-preamble">
            <span className="landing-thread-timestamp">
              Today {localClock(clock, true)}
            </span>
          </div>
          {items.map((item) =>
            item.kind === "card" ? (
              <div key={item.id} className="landing-bubble-card">
                <DemoCardBubble card={item.card} />
              </div>
            ) : (
              <p
                key={item.id}
                className={`landing-bubble landing-bubble--${item.from}`}
              >
                {item.text}
              </p>
            ),
          )}
          {elizaTyping ? (
            <div className="landing-bubble landing-bubble--eliza landing-typing">
              <span />
              <span />
              <span />
            </div>
          ) : null}
        </div>
        <div className="landing-composer-row">
          <span className="landing-composer-plus">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <div
            className="landing-phone-composer"
            data-typing={composerText !== ""}
          >
            <span className="landing-composer-text">
              <span className="landing-composer-typed">
                {composerText === "" ? (
                  t("homepage_eliza.landing.demoComposer", {
                    defaultValue: "iMessage",
                  })
                ) : (
                  <>
                    {composerText}
                    <span className="landing-composer-caret" />
                  </>
                )}
              </span>
            </span>
            {composerText === "" ? (
              <svg
                className="landing-composer-mic"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 11v1a7 7 0 0 1-14 0v-1M12 19v3" />
              </svg>
            ) : (
              <span className="landing-composer-send">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </span>
            )}
          </div>
        </div>
        <DemoKeyboard composerText={composerText} />
        <div className="landing-iphone-homebar" />
      </div>
    </div>
  );
}

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"] as const;

/**
 * iOS-style keyboard that slides up while the demo user is typing. The key
 * matching the most recent character lights briefly, and the prediction bar
 * echoes the word in progress the way iOS QuickType does.
 */
function DemoKeyboard({ composerText }: { composerText: string }) {
  const open = composerText !== "";
  const lastChar = composerText.slice(-1).toLowerCase();
  const lastWord = composerText.split(/\s+/).pop() ?? "";
  return (
    <div className="landing-keyboard" data-open={open}>
      <div className="landing-keyboard-inner">
        <div className="landing-kb-suggestions">
          <span>{lastWord ? `“${lastWord}”` : ""}</span>
          <span>{lastWord}</span>
          <span>{lastWord ? `${lastWord}s` : ""}</span>
        </div>
        {KEYBOARD_ROWS.map((row, rowIndex) => (
          <div key={row} className="landing-kb-row">
            {rowIndex === 2 ? (
              <span className="landing-kb-key landing-kb-key--special">⇧</span>
            ) : null}
            {row.split("").map((key) => (
              <span
                key={key}
                className="landing-kb-key"
                data-active={key === lastChar}
              >
                {key}
              </span>
            ))}
            {rowIndex === 2 ? (
              <span className="landing-kb-key landing-kb-key--special">⌫</span>
            ) : null}
          </div>
        ))}
        <div className="landing-kb-row">
          <span className="landing-kb-key landing-kb-key--special">123</span>
          <span
            className="landing-kb-key landing-kb-key--space"
            data-active={lastChar === " "}
          />
          <span className="landing-kb-key landing-kb-key--return">return</span>
        </div>
        <div className="landing-kb-bottom">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
          </svg>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 11v1a7 7 0 0 1-14 0v-1M12 19v3" />
          </svg>
        </div>
      </div>
    </div>
  );
}

const SESSION_STORAGE_KEY = "eliza_app_session";

export default function LandingPage() {
  const t = useT();
  const [phoneCopyState, setPhoneCopyState] = useState<
    "idle" | "copied" | "error"
  >("idle");
  const phoneCopyResetRef = useRef<number | null>(null);
  const browserWindow = typeof window === "undefined" ? null : window;
  const signedIn =
    browserWindow !== null &&
    browserWindow.localStorage.getItem(SESSION_STORAGE_KEY) !== null;
  const productNavigation = resolveHomepageProductNavigation(
    browserWindow?.location.hostname ?? "",
  );

  useEffect(
    () => () => {
      if (phoneCopyResetRef.current !== null) {
        window.clearTimeout(phoneCopyResetRef.current);
      }
    },
    [],
  );

  const copyPhoneNumber = async () => {
    try {
      await navigator.clipboard.writeText(ELIZA_PHONE_NUMBER);
      setPhoneCopyState("copied");
    } catch {
      setPhoneCopyState("error");
    }
    if (phoneCopyResetRef.current !== null) {
      window.clearTimeout(phoneCopyResetRef.current);
    }
    phoneCopyResetRef.current = window.setTimeout(
      () => setPhoneCopyState("idle"),
      2_000,
    );
  };

  const phoneCopyLabel =
    phoneCopyState === "copied"
      ? t("homepage_eliza.landing.phoneCopied", {
          defaultValue: "Copied!",
        })
      : phoneCopyState === "error"
        ? t("homepage_eliza.landing.phoneCopyFailed", {
            defaultValue: "Couldn't copy",
          })
        : ELIZA_PHONE_FORMATTED;
  return (
    <div className="landing-page theme-app">
      <Suspense fallback={null}>
        <ShaderBackground />
      </Suspense>
      <div aria-hidden="true" className="landing-grain" />
      <header className="landing-header">
        <a
          className="landing-brand"
          href="/"
          aria-label={t("homepage_eliza.landing.brandAria", {
            defaultValue: "Eliza",
          })}
        >
          <img src={elizaLogotextUrl} alt="Eliza" />
        </a>
        <a
          className="landing-cta landing-cta--white landing-header-cta"
          href={
            signedIn
              ? productNavigation.dashboardUrl
              : productNavigation.signInUrl
          }
        >
          {signedIn
            ? t("homepage_eliza.landing.dashboard", {
                defaultValue: "Dashboard",
              })
            : t("homepage_eliza.landing.signIn", { defaultValue: "Sign in" })}
        </a>
      </header>
      <main className="landing-hero">
        <div className="landing-hero-copy">
          <h1 className="landing-hero-heading">
            {t("homepage_eliza.landing.heroTitle", {
              defaultValue: "Four hours of your time back every week.",
            })}
          </h1>
          <p className="landing-hero-lede">
            {t("homepage_eliza.landing.heroLede", {
              defaultValue:
                "Hey, I'm Eliza — your personal assistant. I'm here to save you time and take things off your plate.",
            })}
          </p>
          <div className="landing-hero-actions">
            <a
              className="landing-cta landing-cta--black"
              href={buildElizaSmsHref()}
            >
              <IMessageIcon className="size-5" />
              {t("homepage_eliza.landing.ctaText", {
                defaultValue: "Text Eliza",
              })}
            </a>
          </div>
          <button
            type="button"
            className="landing-phone-number"
            onClick={() => void copyPhoneNumber()}
            aria-label={t("homepage_eliza.landing.copyPhone", {
              defaultValue: "Copy Eliza's phone number",
            })}
          >
            <span aria-live="polite">{phoneCopyLabel}</span>
          </button>
        </div>
        <PhoneMockup />
      </main>
    </div>
  );
}
