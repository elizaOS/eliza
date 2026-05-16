import { ProductSwitcher as SharedProductSwitcher } from "@elizaos/ui/product-switcher";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Cloud,
  Code2,
  Download,
  ExternalLink,
  KeyRound,
  MessageCircle,
  MonitorDown,
  Smartphone,
  Store,
  Terminal,
  Usb,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ElizaLogo } from "@/components/brand/eliza-logo";
import {
  type ReleaseDataDownload,
  type ReleaseDataStoreTarget,
  releaseData,
} from "@/generated/release-data";
import { getElizacloudUrl } from "@/lib/api/client";

type OS =
  | "macos-any"
  | "macos-arm"
  | "macos-intel"
  | "windows"
  | "linux"
  | "unknown";

type DownloadButton = {
  id:
    | OS
    | "linux-deb"
    | "linux-rpm"
    | "linux-appimage"
    | "linux-tar"
    | "android-apk";
  label: string;
  sublabel?: string;
  href: string;
  releaseTagName?: string;
  releaseUrl?: string;
  releasePublishedAtLabel?: string;
  direct?: boolean;
};

type Workstream = {
  title: string;
  body: string;
  items: string[];
};

const LOCAL_APP_URL = import.meta.env.VITE_ELIZA_APP_URL || "/";
const CLOUD_URL = import.meta.env.VITE_ELIZA_CLOUD_URL || getElizacloudUrl();
const DOCS_URL = "https://eliza.how";
const GITHUB_URL = "https://github.com/elizaOS/eliza";
const OS_URL = import.meta.env.VITE_ELIZA_OS_URL || "https://elizaos.ai";
const APP_URL = LOCAL_APP_URL;

const PRODUCT_SWITCHER_ITEMS = [
  { label: "ElizaOS", href: OS_URL, external: !OS_URL.startsWith("/") },
  { label: "Eliza App", href: "/", active: true },
  {
    label: "Eliza Cloud",
    href: CLOUD_URL,
    external: !CLOUD_URL.startsWith("/") && !CLOUD_URL.includes("localhost"),
  },
  { label: "Docs", href: DOCS_URL, external: true },
  { label: "GitHub", href: GITHUB_URL, external: true },
];

const FALLBACK_MAC_BUTTONS: DownloadButton[] = [
  {
    id: "macos-arm",
    label: "macOS Apple Silicon",
    sublabel: "M1 / M2 / M3 (.dmg pending)",
    href: `${GITHUB_URL}/releases`,
    direct: false,
  },
  {
    id: "macos-intel",
    label: "macOS Intel",
    sublabel: "x86_64 (.dmg pending)",
    href: `${GITHUB_URL}/releases`,
    direct: false,
  },
];

const FALLBACK_WINDOWS_BUTTONS: DownloadButton[] = [
  {
    id: "windows",
    label: "Windows",
    sublabel: "x86_64 installer (.exe pending)",
    href: `${GITHUB_URL}/releases`,
    direct: false,
  },
];

const FALLBACK_LINUX_BUTTONS: DownloadButton[] = [
  {
    id: "linux-deb",
    label: "Debian / Ubuntu",
    sublabel: ".deb pending",
    href: `${GITHUB_URL}/releases`,
    direct: false,
  },
  {
    id: "linux-rpm",
    label: "Fedora / RHEL",
    sublabel: ".rpm pending",
    href: `${GITHUB_URL}/releases`,
    direct: false,
  },
  {
    id: "linux-appimage",
    label: "AppImage",
    sublabel: "Portable pending",
    href: `${GITHUB_URL}/releases`,
    direct: false,
  },
  {
    id: "linux-tar",
    label: "Tarball",
    sublabel: ".tar.gz pending",
    href: `${GITHUB_URL}/releases`,
    direct: false,
  },
];

const FALLBACK_MOBILE_BUTTONS: DownloadButton[] = [
  {
    id: "android-apk",
    label: "Android APK",
    sublabel: "Signed QA APK pending",
    href: `${GITHUB_URL}/releases`,
    direct: false,
  },
];

function detailForStoreTarget(target: ReleaseDataStoreTarget): string {
  switch (target.platform) {
    case "ios":
      return "TestFlight is the first consumer beta path before App Store review.";
    case "android":
      return "APK releases attach to GitHub builds before the Play Store listing is live.";
    case "macos":
      return "Signed .dmg builds are the primary macOS release path.";
    case "windows":
      return "The Windows .exe installer remains the primary release path.";
    default:
      return `${target.fallbackArtifact} remains the fallback install path.`;
  }
}

function platformLabelForStoreTarget(target: ReleaseDataStoreTarget): string {
  switch (target.platform) {
    case "ios":
      return "iPhone";
    case "android":
      return "Android";
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    default:
      return target.label;
  }
}

function statusLabelForStoreTarget(target: ReleaseDataStoreTarget): string {
  switch (target.status) {
    case "available":
      return "Available";
    case "beta":
      return "Beta";
    case "coming-soon":
      return "Coming soon";
  }
}

const PLATFORM_TAXONOMY = [
  "macOS: Apple Silicon .dmg and Intel .dmg",
  "Windows: x64 installer .exe",
  "Linux: .deb, .rpm, AppImage, and .tar.gz",
  "Mobile: iOS App Store and Android Play Store coming soon; signed Android APK for QA",
];

const ONBOARDING_CHANNELS = [
  {
    name: "iMessage",
    state: "Advanced gateway",
    method: "imessage",
    body: "Blue-text onboarding runs through a Mac-hosted bridge connected by Headscale for power users.",
  },
  {
    name: "Discord",
    state: "Bot invite",
    method: "discord",
    body: "Invite the bot, finish account linking, then continue with the same provisioned agent.",
  },
  {
    name: "Telegram",
    state: "Best first bot",
    method: "telegram",
    body: "Start the bot, verify identity, and move the onboarding thread into the user agent.",
  },
  {
    name: "WhatsApp",
    state: "Business API",
    method: "whatsapp",
    body: "Use the official Business Platform path with opt-in, templates, and compliance review.",
  },
];

const WORKSTREAMS: Workstream[] = [
  {
    title: "Brand architecture",
    body: "One account and one design system across ElizaOS, Eliza App, and Eliza Cloud.",
    items: [
      "ElizaOS: operating system at elizaos.ai with Install ElizaOS as the primary CTA.",
      `Eliza App: desktop and mobile app at ${APP_URL} with Download the app as the primary CTA.`,
      "Eliza Cloud: hosted runtime at elizacloud.ai / eliza.cloud with Run in cloud as the primary CTA.",
    ],
  },
  {
    title: "App distribution",
    body: "Make the app download path feel first-party on every platform before leaning on app stores.",
    items: [
      "Desktop releases: .dmg, .exe, AppImage, .deb, .rpm, and tarball from GitHub release assets.",
      "Mobile releases: App Store and Play Store are coming soon; TestFlight and signed Android APK bridge the gap.",
      "Release page: show generated release metadata and keep stale package-manager commands out of the main CTA path.",
    ],
  },
  {
    title: "Messaging onboarding",
    body: "Every social channel starts with the same stateless onboarding agent, then hands off to the user's real agent.",
    items: [
      "iMessage gateway: Mac + spare iPhone + BlueBubbles-style bridge behind the Headscale tunnel.",
      "Discord, Telegram, WhatsApp: bot invite or account link starts the same onboarding flow.",
      "Provisioning: successful onboarding binds phone/social identity, creates the cloud account, starts one user agent, and transfers the thread.",
    ],
  },
  {
    title: "Single user agent",
    body: "The product centers on one durable personal agent, not a character roster or multi-agent playground.",
    items: [
      "Cloud console gets My Agent for runtime status, admin, devices, channels, billing, API keys, and settings.",
      "Consumer character chat and generation studio paths move out of the main product surface.",
      "Sub-agents remain an internal capability of the user's agent, not a setup decision for the user.",
    ],
  },
];

function buildButtonFromGenerated(
  d: ReleaseDataDownload,
): DownloadButton | null {
  const sublabel = d.note ? `${d.note} · ${d.sizeLabel}` : d.sizeLabel;
  switch (d.id) {
    case "macos-arm64":
      return {
        id: "macos-arm",
        label: "macOS Apple Silicon",
        sublabel,
        href: d.url,
        releaseTagName: d.releaseTagName,
        releaseUrl: d.releaseUrl,
        releasePublishedAtLabel: d.releasePublishedAtLabel,
      };
    case "macos-x64":
      return {
        id: "macos-intel",
        label: "macOS Intel",
        sublabel,
        href: d.url,
        releaseTagName: d.releaseTagName,
        releaseUrl: d.releaseUrl,
        releasePublishedAtLabel: d.releasePublishedAtLabel,
      };
    case "windows-x64":
      return {
        id: "windows",
        label: "Windows",
        sublabel,
        href: d.url,
        releaseTagName: d.releaseTagName,
        releaseUrl: d.releaseUrl,
        releasePublishedAtLabel: d.releasePublishedAtLabel,
      };
    case "linux-x64":
      if (/\.appimage$/i.test(d.fileName)) {
        return {
          id: "linux-appimage",
          label: "AppImage",
          sublabel,
          href: d.url,
          releaseTagName: d.releaseTagName,
          releaseUrl: d.releaseUrl,
          releasePublishedAtLabel: d.releasePublishedAtLabel,
        };
      }
      return {
        id: "linux-tar",
        label: "Tarball",
        sublabel,
        href: d.url,
        releaseTagName: d.releaseTagName,
        releaseUrl: d.releaseUrl,
        releasePublishedAtLabel: d.releasePublishedAtLabel,
      };
    case "linux-deb":
      return {
        id: "linux-deb",
        label: "Debian / Ubuntu",
        sublabel,
        href: d.url,
        releaseTagName: d.releaseTagName,
        releaseUrl: d.releaseUrl,
        releasePublishedAtLabel: d.releasePublishedAtLabel,
      };
    case "linux-rpm":
      return {
        id: "linux-rpm",
        label: "Fedora / RHEL",
        sublabel,
        href: d.url,
        releaseTagName: d.releaseTagName,
        releaseUrl: d.releaseUrl,
        releasePublishedAtLabel: d.releasePublishedAtLabel,
      };
    case "android-apk":
      return {
        id: "android-apk",
        label: "Android APK",
        sublabel,
        href: d.url,
        releaseTagName: d.releaseTagName,
        releaseUrl: d.releaseUrl,
        releasePublishedAtLabel: d.releasePublishedAtLabel,
      };
    default:
      return null;
  }
}

function partitionGeneratedDownloads(
  downloads: readonly ReleaseDataDownload[],
) {
  const mac: DownloadButton[] = [];
  const windows: DownloadButton[] = [];
  const linux: DownloadButton[] = [];
  const mobile: DownloadButton[] = [];
  for (const d of downloads) {
    const button = buildButtonFromGenerated(d);
    if (!button) continue;
    if (button.id === "macos-arm" || button.id === "macos-intel") {
      mac.push(button);
    } else if (button.id === "windows") {
      windows.push(button);
    } else if (button.id === "android-apk") {
      mobile.push(button);
    } else {
      linux.push(button);
    }
  }
  return { mac, windows, linux, mobile };
}

const generated = partitionGeneratedDownloads(releaseData.release.downloads);

const MAC_BUTTONS: DownloadButton[] =
  generated.mac.length > 0 ? generated.mac : FALLBACK_MAC_BUTTONS;
const WINDOWS_BUTTONS: DownloadButton[] =
  generated.windows.length > 0 ? generated.windows : FALLBACK_WINDOWS_BUTTONS;
const LINUX_BUTTONS: DownloadButton[] =
  generated.linux.length > 0 ? generated.linux : FALLBACK_LINUX_BUTTONS;
const MOBILE_BUTTONS: DownloadButton[] =
  generated.mobile.length > 0 ? generated.mobile : FALLBACK_MOBILE_BUTTONS;

const RELEASE_TAG_LABEL =
  releaseData.release.tagName !== "unavailable"
    ? releaseData.release.tagName
    : null;
const RELEASE_PUBLISHED_LABEL =
  releaseData.release.publishedAtLabel !== "unavailable"
    ? releaseData.release.publishedAtLabel
    : null;
const HAS_RELEASE_DOWNLOADS = releaseData.release.downloads.length > 0;
const STORE_TARGETS = releaseData.storeTargets;

function detectOS(): OS {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || "").toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux") && !ua.includes("android")) return "linux";
  if (ua.includes("mac") || platform.includes("mac")) return "macos-any";
  return "unknown";
}

function ProductNav() {
  return (
    <SharedProductSwitcher
      activeClassName="bg-neutral-950 text-white"
      className="border-neutral-950/10 bg-white/70 text-neutral-500"
      inactiveClassName="hover:bg-white hover:text-neutral-950"
      items={PRODUCT_SWITCHER_ITEMS}
    />
  );
}

function DownloadCard({
  button,
  highlighted,
}: {
  button: DownloadButton;
  highlighted: boolean;
}) {
  const hasRelease =
    button.releaseTagName && button.releaseTagName !== "unavailable";

  return (
    <a
      href={button.href}
      className={[
        "group flex min-h-[104px] flex-col justify-between rounded-lg border p-4 transition-colors",
        highlighted
          ? "border-[#FF5800] bg-[#FF5800] text-black shadow-[0_16px_40px_rgba(255,88,0,0.18)] hover:bg-neutral-950 hover:text-white"
          : "border-neutral-200 bg-white text-neutral-950 hover:border-neutral-950",
      ].join(" ")}
    >
      <span className="flex items-start justify-between gap-3">
        <span>
          <span className="block text-base font-semibold leading-tight">
            {button.label}
          </span>
          {button.sublabel ? (
            <span
              className={[
                "mt-1 block text-xs",
                highlighted
                  ? "text-black/65 group-hover:text-white/65"
                  : "text-neutral-500",
              ].join(" ")}
            >
              {button.sublabel}
            </span>
          ) : null}
        </span>
        <Download className="size-4 shrink-0" />
      </span>
      {hasRelease ? (
        <span
          className={[
            "text-xs",
            highlighted
              ? "text-black/55 group-hover:text-white/55"
              : "text-neutral-400",
          ].join(" ")}
        >
          From {button.releaseTagName}
          {button.releasePublishedAtLabel &&
          button.releasePublishedAtLabel !== "unavailable"
            ? ` · ${button.releasePublishedAtLabel}`
            : null}
        </span>
      ) : button.direct === false ? (
        <span className="text-xs text-neutral-400">Opens release page</span>
      ) : null}
    </a>
  );
}

function DownloadColumn({
  title,
  buttons,
  highlightId,
}: {
  title: string;
  buttons: DownloadButton[];
  highlightId: OS | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
        {title}
      </h3>
      <div className="grid gap-3">
        {buttons.map((b) => (
          <DownloadCard
            key={b.id}
            button={b}
            highlighted={highlightId !== null && b.id === highlightId}
          />
        ))}
      </div>
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <div className="max-w-3xl">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#B74100]">
        {eyebrow}
      </p>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-950 md:text-5xl">
        {title}
      </h2>
      <p className="mt-4 text-base leading-7 text-neutral-600 md:text-lg">
        {body}
      </p>
    </div>
  );
}

function ComingSoonBadge() {
  return (
    <span className="rounded-full border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-500">
      Coming soon
    </span>
  );
}

export default function Marketing() {
  const [os, setOS] = useState<OS>("unknown");

  useEffect(() => {
    setOS(detectOS());
  }, []);

  const highlightId: OS | null = useMemo(() => {
    if (os === "unknown") return null;
    return os;
  }, [os]);

  return (
    <main className="min-h-screen bg-[#F7F4EF] text-neutral-950">
      <header className="sticky top-0 z-30 border-b border-neutral-950/10 bg-[#F7F4EF]/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4 md:px-8">
          <a href="/" className="flex items-center gap-3">
            <ElizaLogo className="h-7" />
            <span className="hidden text-sm font-semibold sm:inline">
              Eliza App
            </span>
          </a>
          <ProductNav />
        </div>
      </header>

      <section className="border-b border-neutral-950/10">
        <div className="mx-auto grid min-h-[calc(100vh-73px)] max-w-7xl gap-10 px-5 py-10 md:grid-cols-[minmax(0,1.04fr)_minmax(360px,0.96fr)] md:px-8 md:py-14">
          <div className="flex flex-col justify-center">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[#B74100]">
              ElizaOS Platform / Eliza App
            </p>
            <h1 className="mt-5 max-w-4xl text-6xl font-semibold leading-[0.95] tracking-tight text-neutral-950 md:text-8xl">
              Your Eliza, everywhere.
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-neutral-700 md:text-xl">
              Download the normal desktop and mobile app, connect it to Eliza
              Cloud, and keep one personal agent with you across app, web, OS,
              and messaging channels.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="#download"
                className="inline-flex min-h-12 items-center gap-2 rounded-md bg-neutral-950 px-5 text-sm font-semibold text-white transition-colors hover:bg-[#FF5800] hover:text-black"
              >
                <Download className="size-4" />
                Download the app
              </a>
              <a
                href={`${CLOUD_URL}/dashboard/my-agents`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-12 items-center gap-2 rounded-md border border-neutral-300 px-5 text-sm font-semibold text-neutral-900 transition-colors hover:border-neutral-950 hover:bg-white"
              >
                <Cloud className="size-4" />
                Try Eliza Cloud
              </a>
              <a
                href={OS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-12 items-center gap-2 rounded-md border border-neutral-300 px-5 text-sm font-semibold text-neutral-900 transition-colors hover:border-neutral-950 hover:bg-white"
              >
                <Terminal className="size-4" />
                Install ElizaOS
              </a>
            </div>
          </div>

          <div className="flex items-end">
            <div className="w-full border border-neutral-950 bg-neutral-950 p-3 shadow-[12px_12px_0_#FF5800]">
              <div className="border border-white/10 bg-[#101010]">
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                  <div className="flex gap-1.5">
                    <span className="size-2.5 rounded-full bg-[#FF5800]" />
                    <span className="size-2.5 rounded-full bg-white/30" />
                    <span className="size-2.5 rounded-full bg-white/30" />
                  </div>
                  <span className="text-xs text-white/45">My Agent</span>
                </div>
                <div className="grid gap-0 md:grid-cols-[0.72fr_1fr]">
                  <aside className="border-b border-white/10 p-4 md:border-b-0 md:border-r">
                    <div className="rounded-md bg-white p-3 text-neutral-950">
                      <div className="flex items-center gap-2">
                        <Bot className="size-4 text-[#FF5800]" />
                        <span className="text-sm font-semibold">Eliza</span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-neutral-600">
                        One personal agent. Connected to Cloud, app devices, and
                        your messaging channels.
                      </p>
                    </div>
                    <div className="mt-4 grid gap-2 text-xs text-white/60">
                      <span className="rounded border border-white/10 px-3 py-2">
                        iMessage gateway advanced
                      </span>
                      <span className="rounded border border-white/10 px-3 py-2">
                        Discord bot linked
                      </span>
                      <span className="rounded border border-white/10 px-3 py-2">
                        API keys managed in Cloud
                      </span>
                    </div>
                  </aside>
                  <div className="min-h-[420px] p-4">
                    <div className="ml-auto max-w-[82%] rounded-lg bg-[#FF5800] px-4 py-3 text-sm leading-6 text-black">
                      Can you finish onboarding me and connect this phone?
                    </div>
                    <div className="mt-4 max-w-[88%] rounded-lg border border-white/10 bg-white/8 px-4 py-3 text-sm leading-6 text-white/80">
                      Yes. I will verify the number, link your Eliza Cloud
                      account, start your agent container, and move this thread
                      over when it is ready.
                    </div>
                    <div className="mt-5 grid gap-2">
                      {[
                        "Phone verified",
                        "Cloud identity linked",
                        "Agent runtime provisioning",
                      ].map((item, index) => (
                        <div
                          key={item}
                          className="flex items-center gap-3 rounded-md border border-white/10 px-3 py-2 text-sm text-white/70"
                        >
                          <CheckCircle2
                            className={[
                              "size-4",
                              index < 2 ? "text-[#FF5800]" : "text-white/30",
                            ].join(" ")}
                          />
                          {item}
                        </div>
                      ))}
                    </div>
                    <div className="mt-24 flex items-center gap-2 rounded-md border border-white/10 bg-black px-3 py-3">
                      <span className="flex-1 text-sm text-white/35">
                        Message your agent...
                      </span>
                      <ArrowRight className="size-4 text-[#FF5800]" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-neutral-950/10 bg-white">
        <div className="mx-auto grid max-w-7xl gap-4 px-5 py-6 md:grid-cols-3 md:px-8">
          {[
            {
              title: "ElizaOS",
              body: "Full operating system for devices that run themselves.",
              cta: "Install ElizaOS",
              href: OS_URL,
            },
            {
              title: "Eliza App",
              body: "Desktop and mobile app for your personal agent.",
              cta: "Download the app",
              href: "#download",
            },
            {
              title: "Eliza Cloud",
              body: "Hosted runtime, dashboard, API keys, billing, and agent admin.",
              cta: "Try Eliza Cloud",
              href: `${CLOUD_URL}/dashboard/my-agents`,
            },
          ].map((product) => (
            <a
              key={product.title}
              href={product.href}
              target={product.href.startsWith("http") ? "_blank" : undefined}
              rel={
                product.href.startsWith("http")
                  ? "noopener noreferrer"
                  : undefined
              }
              className="rounded-lg border border-neutral-200 p-5 transition-colors hover:border-neutral-950"
            >
              <h2 className="text-lg font-semibold">{product.title}</h2>
              <p className="mt-2 min-h-12 text-sm leading-6 text-neutral-600">
                {product.body}
              </p>
              <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#B74100]">
                {product.cta}
                <ArrowRight className="size-4" />
              </span>
            </a>
          ))}
        </div>
      </section>

      <section id="download" className="scroll-mt-24 bg-[#F7F4EF]">
        <div className="mx-auto max-w-7xl px-5 py-20 md:px-8">
          <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <SectionHeader
              eyebrow="Download"
              title="Install the app directly."
              body={
                HAS_RELEASE_DOWNLOADS
                  ? "Pick the build that matches your platform. Desktop installers come from verified release assets; mobile app stores stay clearly marked until the listings are live."
                  : "Pick the platform you need. Desktop installer slots are wired to GitHub releases and open the release page until the signed assets are published."
              }
            />
            <div className="text-sm text-neutral-500">
              {RELEASE_TAG_LABEL ? (
                <p>
                  Latest:{" "}
                  <a
                    href={releaseData.release.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-neutral-950 underline decoration-neutral-300 underline-offset-4 hover:text-[#B74100]"
                  >
                    {RELEASE_TAG_LABEL}
                  </a>
                  {RELEASE_PUBLISHED_LABEL
                    ? ` · ${RELEASE_PUBLISHED_LABEL}`
                    : null}
                </p>
              ) : null}
              <a
                href={`${GITHUB_URL}/releases`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 underline decoration-neutral-300 underline-offset-4 hover:text-[#B74100]"
              >
                All releases
                <ExternalLink className="size-3" />
              </a>
            </div>
          </div>

          <div className="mt-8 rounded-lg border border-neutral-200 bg-white p-5">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
              Platform download taxonomy
            </h3>
            <ul className="mt-4 grid gap-3 text-sm leading-6 text-neutral-700 md:grid-cols-2">
              {PLATFORM_TAXONOMY.map((item) => (
                <li key={item} className="flex gap-3">
                  <CheckCircle2 className="mt-1 size-4 shrink-0 text-[#B74100]" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-4">
            <DownloadColumn
              title="macOS"
              buttons={MAC_BUTTONS}
              highlightId={highlightId}
            />
            <DownloadColumn
              title="Windows"
              buttons={WINDOWS_BUTTONS}
              highlightId={highlightId}
            />
            <DownloadColumn
              title="Linux"
              buttons={LINUX_BUTTONS}
              highlightId={highlightId}
            />
            <DownloadColumn
              title="Mobile"
              buttons={MOBILE_BUTTONS}
              highlightId={null}
            />
          </div>

          <div className="mt-12 flex items-end justify-between gap-4">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
                App stores
              </h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-600">
                Store listings are intentionally grayed out until they are live;
                Android APK is available above only when release CI attaches a
                signed QA build.
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-4">
            {STORE_TARGETS.map((target) => {
              const isAvailable =
                target.status === "available" && Boolean(target.url);
              const CardTag = isAvailable ? "a" : "div";
              return (
                <CardTag
                  key={target.platform}
                  href={isAvailable ? (target.url ?? undefined) : undefined}
                  aria-disabled={isAvailable ? undefined : "true"}
                  className={[
                    "rounded-lg border border-neutral-200 p-5",
                    isAvailable
                      ? "bg-white transition-colors hover:border-neutral-950"
                      : "bg-neutral-100 opacity-60 grayscale",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">
                        {platformLabelForStoreTarget(target)}
                      </h3>
                      <p className="mt-1 text-sm text-neutral-500">
                        {target.artifact}
                      </p>
                    </div>
                    {isAvailable ? (
                      <span className="rounded-full border border-[#FF5800]/30 px-2.5 py-1 text-xs font-medium text-[#B74100]">
                        Available
                      </span>
                    ) : (
                      <ComingSoonBadge />
                    )}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-neutral-600">
                      {statusLabelForStoreTarget(target)}
                    </span>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-neutral-600">
                      {target.rolloutChannel}
                    </span>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-neutral-600">
                      {target.reviewState}
                    </span>
                  </div>
                  <p className="mt-4 text-sm leading-6 text-neutral-600">
                    {detailForStoreTarget(target)}
                  </p>
                </CardTag>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-y border-neutral-950/10 bg-neutral-950 text-white">
        <div className="mx-auto grid max-w-7xl gap-12 px-5 py-20 md:grid-cols-[0.85fr_1.15fr] md:px-8">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#FF5800]">
              Onboarding
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-5xl">
              Start in chat. Finish in your agent.
            </h2>
            <p className="mt-4 text-base leading-7 text-white/65 md:text-lg">
              The same onboarding flow runs in Eliza App, ElizaOS, and messaging
              channels. A stateless cloud worker handles the first conversation,
              then binds identity and hands off to the provisioned user agent.
            </p>
            <ol className="mt-8 grid gap-3 text-sm leading-6 text-white/70">
              {[
                "User starts from app, web, OS, or a messaging channel.",
                "Onboarding verifies phone or social identity and creates the Eliza Cloud account.",
                "Cloud provisions one personal agent, then transfers the conversation into that agent.",
              ].map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#FF5800] text-xs font-semibold text-black">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {ONBOARDING_CHANNELS.map((channel) => (
              <Link
                key={channel.name}
                to={`/get-started?method=${channel.method}`}
                className="group rounded-lg border border-white/10 bg-white/[0.04] p-5 transition-colors hover:border-[#FF5800]/50 hover:bg-white/[0.07]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <MessageCircle className="size-5 shrink-0 text-[#FF5800]" />
                    <h3 className="font-semibold">{channel.name}</h3>
                  </div>
                  <span className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-white/55">
                    {channel.state}
                  </span>
                </div>
                <p className="mt-4 text-sm leading-6 text-white/60">
                  {channel.body}
                </p>
                <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#FF5800]">
                  Start onboarding
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto max-w-7xl px-5 py-20 md:px-8">
          <SectionHeader
            eyebrow="Mobile"
            title="Make iPhone installs honest."
            body="The clean path is App Store or TestFlight. Until then, show a developer sideload flow clearly, with the right warnings before anyone starts."
          />
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {[
              {
                icon: Store,
                title: "Preferred",
                body: "Ship TestFlight first, then App Store. This is the least surprising path for normal users.",
              },
              {
                icon: Smartphone,
                title: "Developer install",
                body: "Provide an installer that checks Xcode, signs the iOS target, and walks the user through trusting the build on their device.",
              },
              {
                icon: KeyRound,
                title: "No false promise",
                body: "Sideloading may require Apple credentials, device trust, profile expiry handling, and regional constraints.",
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-lg border border-neutral-200 p-5"
              >
                <item.icon className="size-5 text-[#B74100]" />
                <h3 className="mt-4 font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-neutral-600">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-neutral-950/10 bg-[#F7F4EF]">
        <div className="mx-auto grid max-w-7xl gap-10 px-5 py-20 md:grid-cols-[0.9fr_1.1fr] md:px-8">
          <div>
            <SectionHeader
              eyebrow="ElizaOS"
              title="The app is the everyday surface. The OS is the full device."
              body="ElizaOS is the full operating system. Eliza App is the normal consumer surface for chat, account setup, downloads, and connected devices."
            />
            <a
              href={OS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-8 inline-flex min-h-12 items-center gap-2 rounded-md bg-neutral-950 px-5 text-sm font-semibold text-white transition-colors hover:bg-[#FF5800] hover:text-black"
            >
              <MonitorDown className="size-4" />
              Install ElizaOS
            </a>
          </div>
          <div className="rounded-lg border border-neutral-200 bg-white p-5">
            <div className="grid gap-5 md:grid-cols-[0.78fr_1fr]">
              <img
                src="/product/elizaos-usb-key-concept.png"
                alt="Concept mockup for a chibi ElizaOS USB installer key"
                className="aspect-square w-full rounded-md object-cover"
              />
              <div className="flex flex-col justify-center">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#B74100]">
                  <Usb className="size-4" />
                  USB installer concept
                </div>
                <h3 className="mt-3 text-2xl font-semibold">
                  Preorder a branded installer, or build your own.
                </h3>
                <p className="mt-4 text-sm leading-6 text-neutral-600">
                  The OS site offers the first-party USB writer for macOS,
                  Windows, and Linux, with clear device selection and explicit
                  hardware support limits.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto max-w-7xl px-5 py-20 md:px-8">
          <SectionHeader
            eyebrow="Platform"
            title="One account, one agent, three ways to use it."
            body="Eliza App keeps the consumer flow simple while Cloud runs the hosted agent and ElizaOS unlocks full device control."
          />
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {WORKSTREAMS.map((stream) => (
              <article
                key={stream.title}
                className="rounded-lg border border-neutral-200 p-6"
              >
                <h3 className="text-lg font-semibold">{stream.title}</h3>
                <p className="mt-2 text-sm leading-6 text-neutral-600">
                  {stream.body}
                </p>
                <ul className="mt-5 grid gap-3">
                  {stream.items.map((item) => (
                    <li
                      key={item}
                      className="flex gap-3 text-sm leading-6 text-neutral-700"
                    >
                      <CheckCircle2 className="mt-1 size-4 shrink-0 text-[#B74100]" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-neutral-950 text-white">
        <div className="mx-auto grid max-w-7xl gap-8 px-5 py-16 md:grid-cols-[1fr_auto] md:items-center md:px-8">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#FF5800]">
              One agent platform
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight">
              Available as an operating system, an app, or a cloud runtime.
            </h2>
          </div>
          <div className="flex flex-wrap gap-3">
            <a
              href="#download"
              className="inline-flex min-h-12 items-center gap-2 rounded-md bg-white px-5 text-sm font-semibold text-neutral-950 transition-colors hover:bg-[#FF5800]"
            >
              <Download className="size-4" />
              Download the app
            </a>
            <a
              href={`${CLOUD_URL}/dashboard/api-explorer`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-12 items-center gap-2 rounded-md border border-white/15 px-5 text-sm font-semibold text-white transition-colors hover:border-white hover:bg-white/10"
            >
              <Code2 className="size-4" />
              Developer dashboard
            </a>
          </div>
        </div>
      </section>

      <footer className="bg-[#F7F4EF] px-5 py-8 md:px-8">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 text-sm text-neutral-500">
          <a href="/" className="font-semibold text-neutral-950">
            Eliza App
          </a>
          <a href={OS_URL} className="hover:text-neutral-950">
            ElizaOS
          </a>
          <a href={CLOUD_URL} className="hover:text-neutral-950">
            Eliza Cloud
          </a>
          <a href={DOCS_URL} className="hover:text-neutral-950">
            Docs
          </a>
          <a href={GITHUB_URL} className="hover:text-neutral-950">
            GitHub
          </a>
          <Link to="/leaderboard" className="hover:text-neutral-950">
            Leaderboard
          </Link>
          <span className="ml-auto text-neutral-400">© 2026 elizaOS</span>
        </div>
      </footer>
    </main>
  );
}
