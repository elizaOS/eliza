import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ElizaLogo } from "@/components/brand/eliza-logo";

type OS = "macos-arm" | "macos-intel" | "windows" | "linux" | "unknown";

const RELEASE_BASE =
  "https://github.com/elizaOS/eliza/releases/latest/download";

type DownloadButton = {
  id: OS | "macos-any" | "linux-deb" | "linux-rpm" | "linux-appimage" | "linux-tar";
  label: string;
  sublabel?: string;
  href: string;
};

const MAC_BUTTONS: DownloadButton[] = [
  {
    id: "macos-arm",
    label: "macOS Apple Silicon",
    sublabel: "M1 / M2 / M3 (.dmg)",
    href: `${RELEASE_BASE}/Eliza-mac-arm64.dmg`,
  },
  {
    id: "macos-intel",
    label: "macOS Intel",
    sublabel: "x86_64 (.dmg)",
    href: `${RELEASE_BASE}/Eliza-mac-x64.dmg`,
  },
];

const WINDOWS_BUTTONS: DownloadButton[] = [
  {
    id: "windows",
    label: "Windows",
    sublabel: "x86_64 installer (.exe)",
    href: `${RELEASE_BASE}/Eliza-win-x64.exe`,
  },
];

const LINUX_BUTTONS: DownloadButton[] = [
  {
    id: "linux-deb",
    label: "Debian / Ubuntu",
    sublabel: ".deb",
    href: `${RELEASE_BASE}/eliza_linux_amd64.deb`,
  },
  {
    id: "linux-rpm",
    label: "Fedora / RHEL",
    sublabel: ".rpm",
    href: `${RELEASE_BASE}/eliza-linux-x86_64.rpm`,
  },
  {
    id: "linux-appimage",
    label: "AppImage",
    sublabel: "Portable",
    href: `${RELEASE_BASE}/Eliza-linux-x86_64.AppImage`,
  },
  {
    id: "linux-tar",
    label: "Tarball",
    sublabel: ".tar.gz",
    href: `${RELEASE_BASE}/eliza-linux-x86_64.tar.gz`,
  },
];

function detectOS(): OS {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || "").toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux") && !ua.includes("android")) return "linux";
  if (ua.includes("mac") || platform.includes("mac")) {
    // Apple Silicon detection is best-effort; modern Safari hides it.
    // Treat the user agent that explicitly mentions "arm" as Apple Silicon.
    if (ua.includes("arm") || platform.includes("arm")) return "macos-arm";
    return "macos-arm";
  }
  return "unknown";
}

function DownloadCard({
  button,
  highlighted,
}: {
  button: DownloadButton;
  highlighted: boolean;
}) {
  return (
    <a
      href={button.href}
      className={[
        "group flex flex-col gap-1 rounded-lg border px-4 py-3 transition-colors",
        highlighted
          ? "border-[#FF5800] bg-[#FF5800]/10 text-white hover:bg-[#FF5800]/20"
          : "border-white/15 bg-white/5 text-white/90 hover:border-white/40 hover:bg-white/10",
      ].join(" ")}
    >
      <span className="text-base font-semibold leading-tight">{button.label}</span>
      {button.sublabel ? (
        <span className="text-xs text-white/60">{button.sublabel}</span>
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
      <h3 className="text-sm font-mono uppercase tracking-wider text-white/50">
        {title}
      </h3>
      <div className="flex flex-col gap-2">
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
    <main className="relative min-h-screen bg-black text-white">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-10">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ElizaLogo className="h-7 invert" />
          </div>
          <nav className="flex items-center gap-5 text-sm text-white/70">
            <Link
              to="/leaderboard"
              className="transition-colors hover:text-[#FF5800]"
            >
              Leaderboard
            </Link>
            <a
              href="https://github.com/elizaOS/eliza"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[#FF5800]"
            >
              GitHub
            </a>
            <a
              href="https://eliza.how"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[#FF5800]"
            >
              Docs
            </a>
          </nav>
        </header>

        <section className="mt-20 flex flex-col gap-6">
          <h1 className="text-5xl font-semibold leading-tight tracking-tight md:text-7xl">
            Eliza
          </h1>
          <p className="max-w-2xl text-lg text-white/75 md:text-xl">
            An open-source, local-first AI assistant. Runs on your machine,
            connects to the apps you already use, and keeps your data yours.
          </p>
        </section>

        <section className="mt-16">
          <div className="mb-6 flex items-baseline justify-between">
            <h2 className="text-2xl font-semibold">Download</h2>
            <a
              href="https://github.com/elizaOS/eliza/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-white/60 transition-colors hover:text-[#FF5800]"
            >
              All releases
            </a>
          </div>

          <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
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
          </div>

          <div className="mt-10 flex flex-col gap-3 rounded-lg border border-white/10 bg-white/5 p-5">
            <h3 className="text-sm font-mono uppercase tracking-wider text-white/50">
              Package managers
            </h3>
            <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
              <div>
                <div className="mb-1 text-white/80">Homebrew</div>
                <code className="block rounded bg-black/50 px-2 py-1 font-mono text-xs text-white/90">
                  brew install --cask eliza
                </code>
              </div>
              <div>
                <div className="mb-1 text-white/80">Snap</div>
                <code className="block rounded bg-black/50 px-2 py-1 font-mono text-xs text-white/90">
                  snap install eliza
                </code>
              </div>
              <div>
                <div className="mb-1 text-white/80">Flatpak</div>
                <code className="block rounded bg-black/50 px-2 py-1 font-mono text-xs text-white/90">
                  flatpak install flathub ai.eliza.Eliza
                </code>
              </div>
            </div>
            <p className="text-xs text-white/40">
              Package manager listings may not be live yet. If a command fails,
              grab a binary above.
            </p>
          </div>
        </section>

        <footer className="mt-auto pt-20 text-sm text-white/50">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 pt-6">
            <a
              href="https://github.com/elizaOS/eliza"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[#FF5800]"
            >
              GitHub
            </a>
            <Link
              to="/leaderboard"
              className="transition-colors hover:text-[#FF5800]"
            >
              Leaderboard
            </Link>
            <a
              href="https://eliza.how"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[#FF5800]"
            >
              Docs
            </a>
            <span className="ml-auto text-white/40">© 2026 elizaOS</span>
          </div>
        </footer>
      </div>
    </main>
  );
}
