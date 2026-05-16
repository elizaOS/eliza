import { CloudSkyBackground, ElizaCloudLockup } from "@elizaos/ui";
import {
  ArrowRight,
  Boxes,
  Cpu,
  Download,
  ExternalLink,
  GitBranch,
  HardDriveDownload,
  Laptop,
  MonitorCog,
  PackageCheck,
  ShieldCheck,
  Smartphone,
  Terminal,
  Usb,
} from "lucide-react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import Footer from "../../components/landing/Footer";
import LandingHeader from "../../components/layout/landing-header";

const installTargets = [
  {
    icon: Laptop,
    target: "Linux bare metal",
    artifact: "ISO + first-party USB installer",
    detail:
      "Write ElizaOS to a USB key and boot directly on supported x86_64 or arm64 PCs.",
    cta: "ISO + USB installer",
    href: "#usb",
  },
  {
    icon: MonitorCog,
    target: "Desktop VM",
    artifact: "VM image + launcher for macOS, Windows, Linux",
    detail:
      "Bundled launcher, CLI tools, checksums, and signed release manifests.",
    cta: "VM bundles",
    href: "#vm",
  },
  {
    icon: Smartphone,
    target: "Android",
    artifact: "Android ADB installer + AOSP image",
    detail:
      "Guided USB debugging, device discovery, flashing, and post-install validation.",
    cta: "Android installer",
    href: "#android",
  },
  {
    icon: Cpu,
    target: "Mac hardware",
    artifact: "Asahi-style Linux build for selected Intel/M1/M2 Macs",
    detail:
      "Specialized OS path only. Newer Apple Silicon devices may not be supported.",
    cta: "Mac limits",
    href: "#mac",
  },
  {
    icon: Terminal,
    target: "Developers",
    artifact: "Dockerfiles, scripts, source, build docs",
    detail:
      "Reproducible builds and release checks for OS images and installer artifacts.",
    cta: "Developer source",
    href: "#developers",
  },
];

const downloads = [
  ["Beta self-install", "Download and make your own USB", "x86_64, arm64"],
  [
    "Raw image download",
    "Compressed image + SHA-256 manifest",
    "x86_64, arm64",
  ],
  ["Windows host", "VM bundle + USB installer .exe", "x86_64, arm64"],
  [
    "macOS host",
    "VM bundle + USB installer .dmg",
    "Apple Silicon, Intel x86_64",
  ],
  ["Linux host", "VM bundle + AppImage/.deb/.rpm", "x86_64, arm64"],
  ["Linux bare metal", "ISO + USB installer", "x86_64, arm64"],
  [
    "Android",
    "Android ADB installer + AOSP image bundle",
    "Pixel-class supported devices",
  ],
  ["WSL", "Developer bootstrap package", "Windows 11 x86_64/arm64"],
];

const releaseChecks = [
  "Signed installer artifacts and SHA-256 checksums",
  "Removable-drive-only filtering with destructive-write confirmation",
  "Image download resume, checksum verification, and write verification",
  "VM boot smoke test for each host and architecture bundle",
  "Android device detection, flashing dry-run, and post-boot health checks",
  "Clear unsupported Mac hardware warning before download",
];

function CtaLink({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary";
}) {
  const className =
    variant === "primary"
      ? "bg-primary text-primary-fg shadow-[0_18px_46px_rgba(217,95,22,0.32)] hover:bg-accent-hover"
      : "border border-white/42 bg-white/18 text-white shadow-[0_18px_46px_rgba(4,49,93,0.18)] backdrop-blur-xl hover:bg-white/28";

  return (
    <a
      href={href}
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-6 py-3 font-[family-name:var(--font-body)] text-sm font-semibold transition-colors sm:text-base ${className}`}
    >
      {children}
    </a>
  );
}

function SectionHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      <p className="mb-3 text-sm font-bold uppercase text-accent">{eyebrow}</p>
      <h2 className="text-3xl font-bold leading-tight text-white drop-shadow-[0_8px_34px_rgba(4,49,93,0.24)] sm:text-5xl">
        {title}
      </h2>
      {children ? (
        <div className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/82 sm:text-lg">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export default function ElizaOsPage() {
  return (
    <>
      <Helmet>
        <title>ElizaOS - Agentic Operating System</title>
        <meta
          name="description"
          content="Install ElizaOS natively, boot from USB, run VM bundles, or use Android and developer builds."
        />
      </Helmet>
      <CloudSkyBackground
        className="min-h-screen"
        contentClassName="min-h-screen w-full"
        intensity="hero"
      >
        <div className="relative min-h-screen overflow-x-hidden">
          <LandingHeader />

          <main className="pt-24">
            <section className="mx-auto grid min-h-[calc(100vh-6rem)] w-full max-w-7xl items-center gap-10 px-6 pb-16 sm:px-8 lg:grid-cols-[1.04fr_0.76fr] lg:px-12">
              <div>
                <p className="mb-4 text-sm font-bold uppercase text-accent">
                  ElizaOS Platform / Operating System
                </p>
                <h1 className="max-w-4xl text-4xl font-bold leading-tight text-white drop-shadow-[0_8px_34px_rgba(4,49,93,0.34)] sm:text-6xl md:text-7xl">
                  The agentic operating system for devices that run themselves.
                </h1>
                <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/84 drop-shadow-[0_2px_14px_rgba(4,49,93,0.2)] sm:text-xl">
                  Install ElizaOS natively on supported PCs and Android devices,
                  or run it in a first-party VM launcher on macOS, Windows, and
                  Linux. This is a serious OS build, not a normal Mac app.
                </p>
                <div className="mt-10 flex flex-wrap gap-3">
                  <CtaLink href="#downloads">
                    <Download className="h-5 w-5" />
                    Install the OS
                  </CtaLink>
                  <CtaLink href="#usb" variant="secondary">
                    <Usb className="h-5 w-5" />
                    ISO + USB installer
                  </CtaLink>
                  <CtaLink
                    href="https://github.com/elizaOS/eliza/releases"
                    variant="secondary"
                  >
                    <ExternalLink className="h-5 w-5" />
                    Release artifacts
                  </CtaLink>
                </div>
                <p className="mt-6 max-w-2xl border-l-4 border-accent bg-white/18 px-4 py-3 text-sm leading-relaxed text-white shadow-sm backdrop-blur-xl sm:text-base">
                  Supported Mac hardware is limited. Apple Silicon support
                  currently targets selected M1/M2 devices. Newer Macs may not
                  be supported. Mac hosts can run the VM launcher; native Mac
                  hardware support is not the default path.
                </p>
              </div>

              <aside className="grid gap-4" aria-label="ElizaOS release paths">
                <div className="overflow-hidden rounded-lg border border-white/28 bg-[#171717] shadow-[0_24px_70px_rgba(3,28,58,0.24)]">
                  <div className="flex h-9 items-center gap-2 bg-[#24211f] px-4">
                    <span className="h-2.5 w-2.5 rounded-full bg-accent" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#f5b642]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#34a853]" />
                  </div>
                  <pre className="overflow-x-auto p-5 font-mono text-sm leading-7 text-[#f7f1e8]">{`elizaos install --target usb
scan: 3 removable drives
image: elizaos-linux-arm64.iso
verify: sha256 passed
write: ready for confirmation`}</pre>
                </div>
                <div className="rounded-lg border border-white/32 bg-white/24 p-6 text-white shadow-[0_18px_54px_rgba(3,28,58,0.16)] backdrop-blur-2xl">
                  <ElizaCloudLockup logoClassName="h-6" />
                  <h2 className="mt-5 text-3xl font-bold">OS / App / Cloud</h2>
                  <p className="mt-3 text-sm leading-6 text-white/78">
                    One account identity and design system, available as an
                    operating system, an app, or a hosted runtime.
                  </p>
                  <div className="mt-5 grid gap-3 border-t border-white/24 pt-5">
                    {installTargets.map((item) => (
                      <a
                        key={item.target}
                        href={item.href}
                        className="flex items-center justify-between gap-3 rounded-lg bg-white/16 px-3 py-2 text-sm transition-colors hover:bg-white/26"
                      >
                        <span>{item.cta}</span>
                        <ArrowRight className="h-4 w-4" />
                      </a>
                    ))}
                  </div>
                </div>
              </aside>
            </section>

            <section id="downloads" className="px-6 py-16 sm:px-8 lg:px-12">
              <SectionHeader
                eyebrow="Download paths"
                title="Install natively, boot from USB, or launch a VM"
              >
                <p>
                  ElizaOS ships as native media, VM bundles, Android images, raw
                  downloads, and developer packages. The download matrix keeps
                  each route explicit before artifacts are hosted behind
                  os.elizacloud.ai.
                </p>
              </SectionHeader>

              <div className="mx-auto mt-10 grid max-w-7xl gap-4 sm:grid-cols-2 lg:grid-cols-5">
                {installTargets.map((item) => {
                  const Icon = item.icon;
                  return (
                    <article
                      id={
                        item.target === "Desktop VM"
                          ? "vm"
                          : item.target === "Mac hardware"
                            ? "mac"
                            : item.target === "Developers"
                              ? "developers"
                              : item.target.toLowerCase().split(" ")[0]
                      }
                      key={item.target}
                      className="rounded-lg border border-white/32 bg-white/24 p-5 text-white shadow-[0_18px_54px_rgba(3,28,58,0.14)] backdrop-blur-2xl"
                    >
                      <Icon className="h-7 w-7 text-accent" />
                      <h3 className="mt-4 text-lg font-bold">{item.target}</h3>
                      <strong className="mt-2 block text-sm text-white/90">
                        {item.artifact}
                      </strong>
                      <p className="mt-3 text-sm leading-6 text-white/74">
                        {item.detail}
                      </p>
                    </article>
                  );
                })}
              </div>

              <div className="mx-auto mt-8 max-w-7xl overflow-hidden rounded-lg border border-white/32 bg-white/24 text-white shadow-[0_18px_54px_rgba(3,28,58,0.14)] backdrop-blur-2xl">
                <div className="grid grid-cols-3 gap-4 border-b border-white/24 bg-white/18 px-4 py-3 text-sm font-bold uppercase text-white/76">
                  <span>Platform</span>
                  <span>Artifact</span>
                  <span>Architecture</span>
                </div>
                {downloads.map(([platform, artifact, architecture]) => (
                  <div
                    key={platform}
                    className="grid grid-cols-1 gap-2 border-b border-white/18 px-4 py-4 text-sm last:border-b-0 sm:grid-cols-3 sm:gap-4"
                  >
                    <span className="font-semibold">{platform}</span>
                    <span className="text-white/82">{artifact}</span>
                    <span className="text-white/72">{architecture}</span>
                  </div>
                ))}
              </div>
            </section>

            <section id="usb" className="px-6 py-16 sm:px-8 lg:px-12">
              <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[0.95fr_1.05fr]">
                <div className="rounded-lg border border-white/32 bg-white/24 p-6 text-white shadow-[0_18px_54px_rgba(3,28,58,0.14)] backdrop-blur-2xl sm:p-8">
                  <p className="text-sm font-bold uppercase text-accent">
                    First-party USB setup
                  </p>
                  <h2 className="mt-3 text-3xl font-bold sm:text-4xl">
                    Pre-order the ElizaOS USB key or make your own
                  </h2>
                  <p className="mt-4 text-base leading-7 text-white/80">
                    USB key presale is $49 each, with hardware planned to ship
                    in October 2026. The beta self-installer path lets users
                    download ElizaOS, prepare their own USB key, and validate
                    the boot media without third-party flashing tools.
                  </p>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg bg-white/16 p-4">
                      <span className="text-sm text-white/70">Presale</span>
                      <strong className="mt-1 block text-3xl">$49</strong>
                      <p className="mt-2 text-sm text-white/74">
                        Branded ElizaOS USB installer key. Ships October 2026.
                      </p>
                    </div>
                    <div className="rounded-lg bg-white/16 p-4">
                      <span className="text-sm text-white/70">Beta path</span>
                      <strong className="mt-1 block text-3xl">DIY USB</strong>
                      <p className="mt-2 text-sm text-white/74">
                        Installer, raw image, and checksum manifest track.
                      </p>
                    </div>
                  </div>
                  <div className="mt-6 flex flex-wrap gap-3">
                    <CtaLink href="https://github.com/elizaOS/eliza/releases">
                      <PackageCheck className="h-5 w-5" />
                      Release downloads
                    </CtaLink>
                    <CtaLink
                      href="https://github.com/elizaOS/eliza"
                      variant="secondary"
                    >
                      <GitBranch className="h-5 w-5" />
                      Source on GitHub
                    </CtaLink>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                  {[
                    {
                      icon: HardDriveDownload,
                      title: "PC native / USB",
                      copy: "Signed USB installer, removable drive filtering, boot media verification, and post-install health checks.",
                    },
                    {
                      icon: Boxes,
                      title: "VM launcher",
                      copy: "macOS, Windows, and Linux host bundles validate the image and local hardware before launch.",
                    },
                    {
                      icon: Smartphone,
                      title: "Android ADB",
                      copy: "ADB and fastboot preflight, image selection, guided flash flow, and recovery guidance.",
                    },
                  ].map((item) => {
                    const Icon = item.icon;
                    return (
                      <article
                        key={item.title}
                        className="rounded-lg border border-white/32 bg-white/24 p-5 text-white shadow-[0_18px_54px_rgba(3,28,58,0.14)] backdrop-blur-2xl"
                      >
                        <Icon className="h-7 w-7 text-accent" />
                        <h3 className="mt-4 font-bold">{item.title}</h3>
                        <p className="mt-3 text-sm leading-6 text-white/74">
                          {item.copy}
                        </p>
                      </article>
                    );
                  })}
                </div>
              </div>
            </section>

            <section className="px-6 py-16 sm:px-8 lg:px-12">
              <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[0.8fr_1.2fr]">
                <SectionHeader
                  eyebrow="Release gates"
                  title="Prepared for GitHub releases"
                >
                  <p>
                    Every artifact needs a manifest, checksum, signature,
                    install instructions, and smoke-test evidence before it is
                    linked from the production OS domain.
                  </p>
                </SectionHeader>
                <div className="grid gap-3 sm:grid-cols-2">
                  {releaseChecks.map((item) => (
                    <div
                      key={item}
                      className="flex gap-3 rounded-lg border border-white/32 bg-white/24 p-4 text-sm text-white shadow-[0_18px_54px_rgba(3,28,58,0.12)] backdrop-blur-2xl"
                    >
                      <ShieldCheck className="h-5 w-5 shrink-0 text-accent" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="px-6 py-16 sm:px-8 lg:px-12">
              <div className="mx-auto flex max-w-7xl flex-col gap-5 rounded-lg border border-white/32 bg-white/24 p-6 text-white shadow-[0_18px_54px_rgba(3,28,58,0.14)] backdrop-blur-2xl sm:p-8 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-sm font-bold uppercase text-accent">
                    Eliza Cloud
                  </p>
                  <h2 className="mt-2 text-3xl font-bold">
                    Run your agent instantly in the cloud.
                  </h2>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-white/78">
                    Use Cloud for hosted runtime and dashboards, download Eliza
                    App for everyday access, and upgrade to ElizaOS for full
                    device control.
                  </p>
                </div>
                <Link
                  to="/login?intent=signup"
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-fg shadow-[0_18px_46px_rgba(217,95,22,0.32)] transition-colors hover:bg-accent-hover"
                >
                  Run in cloud
                  <ArrowRight className="h-5 w-5" />
                </Link>
              </div>
            </section>
          </main>

          <Footer />
        </div>
      </CloudSkyBackground>
    </>
  );
}
