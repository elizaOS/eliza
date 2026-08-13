/**
 * eliza.app landing page: a single-viewport, personal-feeling lander.
 *
 * The first action opens a real iMessage thread; account and app setup stay out
 * of the way until someone wants the richer companion experience. The phone
 * demo tells the exact Shared product truth: free text chat and memory, metered
 * search, paid voice in the app, and an explicit Dedicated wall for actions.
 * The demo is decorative and intentionally English-only. Reduced motion shows
 * its settled intro, which also keeps screenshot tests deterministic.
 */

import { IMessageIcon } from "@elizaos/ui/cloud-ui/components/icons";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
// Imported through the bundler (not referenced from public/) so the wordmark
// ships with whichever build consumes this source; a public/ path depends on
// the host app's asset-sync allowlist and 404s when it drifts.
import elizaLogotextUrl from "@/assets/eliza-logotext.svg";
import { buildElizaSmsHref, ELIZA_PHONE_FORMATTED } from "@/lib/contact";
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
  { kind: "eliza", text: "Hey, it's Eliza. You can just text me here." },
  { kind: "user", text: "can you remember things for me?" },
  {
    kind: "eliza",
    text: "Yes. This is your personal Eliza, so our conversation carries with you when you sign in later.",
  },
  { kind: "user", text: "remember I'm vegetarian and hate early flights" },
  {
    kind: "eliza",
    text: "Got it. Vegetarian, and no early flights when we can avoid them.",
  },
  {
    kind: "card",
    card: {
      label: "Memory",
      title: "Preferences remembered",
      rows: ["Vegetarian", "Avoid early flights"],
      status: "Saved",
    },
  },
  { kind: "user", text: "find a quiet Italian place near Union Square" },
  {
    kind: "eliza",
    text: "I searched the web and found three current options. Bocca di Bacco has vegetarian choices and the quietest reviews.",
  },
  {
    kind: "card",
    card: {
      label: "Web search",
      title: "Bocca di Bacco",
      rows: ["Italian · Vegetarian options", "Quiet atmosphere"],
      status: "Current result",
    },
  },
  { kind: "user", text: "put it on my calendar for Thursday" },
  {
    kind: "eliza",
    text: "Calendar actions need Dedicated. I can keep helping here on Shared, and I won't upgrade or charge you unless you choose it.",
  },
  {
    kind: "card",
    card: {
      label: "Dedicated",
      title: "Optional upgrade",
      rows: ["Calendar · Email · Coding · Files"],
      status: "Nothing changed",
    },
  },
  { kind: "user", text: "can we talk instead?" },
  {
    kind: "eliza",
    text: "Open the Eliza app for voice. Voice uses credits; texting me here stays free.",
  },
];

const DEMO_LOOP: DemoStep[] = [
  {
    kind: "eliza",
    text: "Want to keep planning Thursday?",
  },
  {
    kind: "user",
    text: "what was the place you found?",
  },
  {
    kind: "eliza",
    text: "Bocca di Bacco near Union Square — quiet, Italian, with vegetarian options.",
  },
  { kind: "user", text: "nice. find me a friday flight to sf too" },
  {
    kind: "eliza",
    text: "Searching current flights now. I'll favor later departures because you told me you hate early flights.",
  },
  {
    kind: "card",
    card: {
      label: "Memory + search",
      title: "Friday to San Francisco",
      rows: ["3 later departures", "Preferences applied"],
      status: "Shared",
    },
  },
  { kind: "user", text: "I'll decide later" },
  { kind: "eliza", text: "Perfect. I'll be right here in Messages." },
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
        <span key={row} className="landing-demo-card-row">
          {row}
        </span>
      ))}
      {card.status ? (
        <span className="landing-demo-card-status">{card.status}</span>
      ) : null}
    </div>
  );
}

function PhoneMockup() {
  const t = useT();
  const [items, setItems] = useState<DemoItem[]>([]);
  const [phase, setPhase] = useState<"intro" | "looping" | "settled">("intro");
  const [elizaTyping, setElizaTyping] = useState(false);
  const [composerText, setComposerText] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const nextIdRef = useRef(DEMO_INTRO.length);

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
            <span className="landing-iphone-time">4:15</span>
            <span className="landing-iphone-island" />
            <span className="landing-iphone-signal">
              <svg viewBox="0 0 46 12" fill="currentColor" aria-hidden="true">
                <rect x="0" y="7" width="3" height="5" rx="1" />
                <rect x="5" y="5" width="3" height="7" rx="1" />
                <rect x="10" y="3" width="3" height="9" rx="1" />
                <rect x="15" y="1" width="3" height="11" rx="1" />
                <rect
                  x="24"
                  y="1"
                  width="20"
                  height="10"
                  rx="3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <rect x="26" y="3" width="14" height="6" rx="1.5" />
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
            <span className="landing-thread-timestamp">Today 4:15 PM</span>
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
  const browserWindow = typeof window === "undefined" ? null : window;
  const signedIn =
    browserWindow !== null &&
    browserWindow.localStorage.getItem(SESSION_STORAGE_KEY) !== null;
  const productNavigation = resolveHomepageProductNavigation(
    browserWindow?.location.hostname ?? "",
  );
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
              defaultValue: "Your personal Eliza starts with one message.",
            })}
          </h1>
          <p className="landing-hero-lede">
            {t("homepage_eliza.landing.heroLede", {
              defaultValue:
                "No account, app, card, or setup. Text Eliza and start free on Shared.",
            })}
          </p>
          <div className="landing-hero-actions">
            <a
              className="landing-cta landing-cta--black"
              href={buildElizaSmsHref()}
            >
              <IMessageIcon className="size-5" />
              {t("homepage_eliza.landing.ctaText", {
                defaultValue: "Message Eliza",
              })}
            </a>
          </div>
          <p className="landing-phone-number">{ELIZA_PHONE_FORMATTED}</p>
          <p className="landing-continuity-note">
            {t("homepage_eliza.landing.continuity", {
              defaultValue:
                "Mostly live in Messages. Sign in with the same number later for voice, history, and controls in the app.",
            })}
          </p>
        </div>
        <PhoneMockup />
      </main>
    </div>
  );
}
