/**
 * Public Eliza landing page centered on direct messaging entry points.
 *
 * The phone remains a fixed iMessage demonstration while the surrounding
 * links hand users directly to Eliza on their preferred channel or web app.
 */
import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import {
  DiscordIcon,
  IMessageIcon,
  TelegramIcon,
  WhatsAppIcon,
} from "@elizaos/ui/cloud-ui/components/icons";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { ElizaLogo } from "@/components/brand/eliza-logo";
import type { ChatRenderState } from "@/components/ModelViewers/ModelB";
import {
  buildElizaDiscordHref,
  buildElizaSmsHref,
  buildElizaTelegramHref,
  buildElizaWhatsAppHref,
} from "@/lib/contact";
import { useT } from "@/providers/I18nProvider";

const ModelB = lazy(() => import("@/components/ModelViewers/ModelB"));

interface ChannelLink {
  href: string;
  label: string;
  icon: ReactNode;
}

export default function LandingPage() {
  const t = useT();
  const [phoneSettled, setPhoneSettled] = useState(false);
  const [chatRenderState, setChatRenderState] = useState<ChatRenderState>({
    phase: "animating",
    renderedMessages: 0,
    totalMessages: 0,
  });

  const channels: ChannelLink[] = [
    {
      href: buildElizaSmsHref(),
      label: "iMessage",
      icon: <IMessageIcon className="size-7 text-[#34C759]" />,
    },
    {
      href: buildElizaWhatsAppHref(),
      label: "WhatsApp",
      icon: <WhatsAppIcon className="size-7 text-[#25D366]" />,
    },
    {
      href: buildElizaTelegramHref(),
      label: "Telegram",
      icon: <TelegramIcon className="size-7 text-[#229ED9]" />,
    },
    {
      href: buildElizaDiscordHref(),
      label: "Discord",
      icon: <DiscordIcon className="size-7 text-[#5865F2]" />,
    },
  ];

  return (
    <main className="theme-app min-h-screen overflow-hidden bg-white text-black">
      <div
        aria-hidden="true"
        className="fixed inset-0 pointer-events-none"
        data-phone-model={
          phoneSettled &&
          chatRenderState.phase === "terminal" &&
          chatRenderState.totalMessages > 0 &&
          chatRenderState.renderedMessages === chatRenderState.totalMessages
            ? "settled"
            : "loading"
        }
        data-chat-phase={chatRenderState.phase}
        data-chat-rendered-messages={chatRenderState.renderedMessages}
        data-chat-total-messages={chatRenderState.totalMessages}
      />

      <Suspense fallback={null}>
        <ModelB
          onReady={() => setPhoneSettled(true)}
          onChatRenderStateChange={setChatRenderState}
        />
      </Suspense>

      <header className="fixed inset-x-0 top-0 z-30 flex items-center justify-between p-5">
        <a
          href={EXTERNAL_URLS.marketing}
          aria-label={t("homepage_eliza.common.brandHomeAria", {
            defaultValue: "Eliza home",
          })}
          className="inline-flex items-center"
        >
          <ElizaLogo className="h-8 w-auto md:h-10" />
        </a>
        <a
          href={EXTERNAL_URLS.app}
          className="rounded-full border border-black/15 bg-white px-5 py-2 text-[15px] font-semibold text-black transition-colors hover:border-[var(--brand-orange)] hover:bg-[var(--brand-orange)]"
        >
          {t("homepage_eliza.leaderboard.signIn", {
            defaultValue: "Sign In",
          })}
        </a>
      </header>

      <nav
        aria-label={t("homepage_eliza.leaderboard.channelNavAria", {
          defaultValue: "Chat with Eliza",
        })}
        className="fixed left-1/2 top-[14%] z-30 -translate-x-1/2"
      >
        <div className="flex items-center gap-1 rounded-full border border-black/10 bg-white p-1.5 shadow-sm">
          {channels.map((channel) => (
            <a
              key={channel.label}
              href={channel.href}
              aria-label={t("homepage_eliza.leaderboard.openChannelAria", {
                defaultValue: "Open Eliza in {{channel}}",
                channel: channel.label,
              })}
              title={channel.label}
              className="flex size-12 items-center justify-center rounded-full transition-colors hover:bg-orange-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-orange)]"
            >
              {channel.icon}
            </a>
          ))}
        </div>
      </nav>
    </main>
  );
}
