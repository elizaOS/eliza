/**
 * eliza.app landing page: a single-viewport, personal-feeling lander.
 *
 * One headline, one row of "call me or text me" entrypoints (phone, iMessage,
 * Telegram, Discord, WhatsApp), and an iPhone-styled message preview. Static
 * DOM + CSS only — no WebGL, no intro choreography, no extra sections.
 */
import {
  DiscordIcon,
  IMessageIcon,
  TelegramIcon,
  WhatsAppIcon,
} from "@elizaos/ui/cloud-ui/components/icons";
import { lazy, Suspense } from "react";
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

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02Z" />
    </svg>
  );
}

function PhoneMockup() {
  const t = useT();
  const messages = [
    {
      from: "user" as const,
      text: t("homepage_eliza.landing.demoUser1", {
        defaultValue: "hey, who's this?",
      }),
    },
    {
      from: "eliza" as const,
      text: t("homepage_eliza.landing.demoEliza1", {
        defaultValue: "it's Eliza :) your new assistant. text me anything",
      }),
    },
    {
      from: "user" as const,
      text: t("homepage_eliza.landing.demoUser2", {
        defaultValue: "remind me to call mom at 6",
      }),
    },
    {
      from: "eliza" as const,
      text: t("homepage_eliza.landing.demoEliza2", {
        defaultValue: "done — I'll nudge you at 6:00 PM 📞",
      }),
    },
  ];
  return (
    <div className="landing-iphone" aria-hidden="true">
      <div className="landing-iphone-screen">
        <div className="landing-iphone-statusbar">
          <span className="landing-iphone-time">9:41</span>
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
          <img
            className="landing-phone-avatar"
            src="/brand/logos/logo_white_orangebg.svg"
            alt=""
            width={423}
            height={423}
          />
          <span className="landing-phone-name">Eliza</span>
          <span className="landing-phone-channel">iMessage</span>
        </div>
        <div className="landing-phone-thread">
          {messages.map((message, index) => (
            <p
              key={message.text}
              className={`landing-bubble landing-bubble--${message.from}`}
              style={{ animationDelay: `${300 + index * 450}ms` }}
            >
              {message.text}
            </p>
          ))}
        </div>
        <div className="landing-phone-composer">
          {t("homepage_eliza.landing.demoComposer", {
            defaultValue: "iMessage",
          })}
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
              defaultValue: "Get 4 hours of your time back every week.",
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
                defaultValue: "Text me",
              })}
            </a>
            <a
              className="landing-cta landing-cta--white"
              href={`tel:${ELIZA_PHONE_NUMBER}`}
            >
              <PhoneIcon className="size-5" />
              {t("homepage_eliza.landing.ctaCall", {
                defaultValue: "Call me",
              })}
            </a>
          </div>
          <div className="landing-channels">
            {channels.map((channel) => (
              <a
                key={channel.key}
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
