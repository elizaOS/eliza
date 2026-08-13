/**
 * eliza.app landing page: a single-viewport, personal-feeling lander.
 *
 * One headline, "call me or text me" entrypoints (phone, iMessage, Telegram,
 * Discord, WhatsApp), and an iPhone-styled iMessage demo that plays a scripted
 * conversation: an intro that runs once, then a vignette reel that loops
 * seamlessly. Eliza's turns show a typing indicator; the user's turns type
 * character-by-character in the composer before sending; task results render
 * as iMessage-style embed cards. The demo is decorative (aria-hidden) and the
 * script is intentionally English-only. Under prefers-reduced-motion the demo
 * renders the settled intro with no playback, which also keeps screenshot
 * tests deterministic.
 */
import {
  DiscordIcon,
  IMessageIcon,
  TelegramIcon,
  WhatsAppIcon,
} from "@elizaos/ui/cloud-ui/components/icons";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  buildElizaDiscordHref,
  buildElizaSmsHref,
  buildElizaTelegramHref,
  buildElizaWhatsAppHref,
  ELIZA_PHONE_NUMBER,
} from "@/lib/contact";
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

type DemoItem =
  | { id: number; from: "eliza" | "user"; kind: "text"; text: string }
  | { id: number; from: "eliza"; kind: "card"; card: DemoCard };

const DEMO_INTRO: DemoStep[] = [
  { kind: "eliza", text: "Hey, it's Eliza — your new assistant." },
  { kind: "user", text: "Hi Eliza, what can you do?" },
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
  // A — dinner
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
  // B — travel
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
  // C — memory
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
  // D — morning brief, seams back into A
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
const USER_KEYSTROKE_MS = 48;
const ELIZA_TYPING_MS = 1750;
const BEAT_PAUSE_MS = 1125;
const PRE_USER_MS = 625;
const PRE_ELIZA_MS = 625;
const PRE_CARD_MS = 750;
const SEND_HOLD_MS = 500;

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
    const append = (item: Omit<DemoItem, "id">) => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      setItems((prev) => [
        ...prev.slice(-(MAX_RENDERED_ITEMS - 1)),
        { ...item, id } as DemoItem,
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
  }, [items, elizaTyping]);

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
        <div className="landing-iphone-homebar" />
      </div>
    </div>
  );
}

export default function LandingPage() {
  const t = useT();
  const channels = [
    {
      key: "telegram",
      href: buildElizaTelegramHref(),
      external: true,
      label: t("homepage_eliza.landing.channelTelegram", {
        defaultValue: "Message Eliza on Telegram",
      }),
      icon: <TelegramIcon className="size-6 text-[#2AABEE]" />,
    },
    {
      key: "discord",
      href: buildElizaDiscordHref(),
      external: true,
      label: t("homepage_eliza.landing.channelDiscord", {
        defaultValue: "Message Eliza on Discord",
      }),
      icon: <DiscordIcon className="size-6 text-[#5865F2]" />,
    },
    {
      key: "whatsapp",
      href: buildElizaWhatsAppHref(),
      external: true,
      label: t("homepage_eliza.landing.channelWhatsapp", {
        defaultValue: "Message Eliza on WhatsApp",
      }),
      icon: <WhatsAppIcon className="size-6 text-[#25D366]" />,
    },
  ];

  return (
    <div className="landing-page theme-app">
      <Suspense fallback={null}>
        <ShaderBackground />
      </Suspense>
      <div
        aria-hidden="true"
        className="fixed inset-0 pointer-events-none mix-blend-overlay bg-[url('/grain.webp')] z-0"
      />
      <main className="landing-hero">
        <div className="landing-hero-copy">
          <h1 className="landing-hero-heading">
            {t("homepage_eliza.landing.heroTitle", {
              defaultValue: "Four hours of your time back every week.",
            })}
          </h1>
          <div className="landing-hero-actions">
            <a
              className="landing-cta landing-cta--black"
              href={buildElizaSmsHref()}
            >
              <IMessageIcon className="size-5" />
              {t("homepage_eliza.landing.ctaText", {
                defaultValue: "Text",
              })}
            </a>
            <a
              className="landing-cta landing-cta--white"
              href={`tel:${ELIZA_PHONE_NUMBER}`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="size-5"
                aria-hidden="true"
              >
                <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02Z" />
              </svg>
              {t("homepage_eliza.landing.ctaCall", {
                defaultValue: "Call",
              })}
            </a>
            {channels.map((channel) => (
              <a
                key={channel.key}
                className="landing-channel"
                href={channel.href}
                aria-label={channel.label}
                title={channel.label}
                target={channel.external ? "_blank" : undefined}
                rel={channel.external ? "noreferrer" : undefined}
              >
                {channel.icon}
              </a>
            ))}
          </div>
        </div>
        <PhoneMockup />
      </main>
    </div>
  );
}
