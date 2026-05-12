import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ElizaLogo } from "@/components/brand/eliza-logo";
import {
  type ReleaseDataDownload,
  releaseData,
} from "@/generated/release-data";
import { getElizacloudUrl } from "@/lib/api/client";

type OS = "macos-arm" | "macos-intel" | "windows" | "linux" | "unknown";

const RELEASE_BASE =
  "https://github.com/elizaOS/eliza/releases/latest/download";
const CLOUD_URL = getElizacloudUrl();

type DownloadButton = {
  id:
    | OS
    | "macos-any"
    | "linux-deb"
    | "linux-rpm"
    | "linux-appimage"
    | "linux-tar";
  label: string;
  sublabel?: string;
  href: string;
};

// Hardcoded fallbacks point at /releases/latest/download by filename. They are
// used when release-data.ts is generated against a release that has no
// installer assets (the desktop release-electrobun.yml workflow has not run
// yet, or its run failed). The names match the artifact names produced by
// release-electrobun.yml.
const FALLBACK_MAC_BUTTONS: DownloadButton[] = [
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

const FALLBACK_WINDOWS_BUTTONS: DownloadButton[] = [
  {
    id: "windows",
    label: "Windows",
    sublabel: "x86_64 installer (.exe)",
    href: `${RELEASE_BASE}/Eliza-win-x64.exe`,
  },
];

const FALLBACK_LINUX_BUTTONS: DownloadButton[] = [
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
      };
    case "macos-x64":
      return { id: "macos-intel", label: "macOS Intel", sublabel, href: d.url };
    case "windows-x64":
      return { id: "windows", label: "Windows", sublabel, href: d.url };
    case "linux-x64":
      // The release-data script produces "linux-x64" for AppImage or .tar.gz;
      // map by file extension so the right card lights up.
      if (/\.appimage$/i.test(d.fileName)) {
        return {
          id: "linux-appimage",
          label: "AppImage",
          sublabel,
          href: d.url,
        };
      }
      return { id: "linux-tar", label: "Tarball", sublabel, href: d.url };
    case "linux-deb":
      return {
        id: "linux-deb",
        label: "Debian / Ubuntu",
        sublabel,
        href: d.url,
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
  for (const d of downloads) {
    const button = buildButtonFromGenerated(d);
    if (!button) continue;
    if (button.id === "macos-arm" || button.id === "macos-intel") {
      mac.push(button);
    } else if (button.id === "windows") {
      windows.push(button);
    } else {
      linux.push(button);
    }
  }
  return { mac, windows, linux };
}

const generated = partitionGeneratedDownloads(releaseData.release.downloads);

const MAC_BUTTONS: DownloadButton[] =
  generated.mac.length > 0 ? generated.mac : FALLBACK_MAC_BUTTONS;
const WINDOWS_BUTTONS: DownloadButton[] =
  generated.windows.length > 0 ? generated.windows : FALLBACK_WINDOWS_BUTTONS;
const LINUX_BUTTONS: DownloadButton[] =
  generated.linux.length > 0 ? generated.linux : FALLBACK_LINUX_BUTTONS;

const RELEASE_TAG_LABEL =
  releaseData.release.tagName !== "unavailable"
    ? releaseData.release.tagName
    : null;
const RELEASE_PUBLISHED_LABEL =
  releaseData.release.publishedAtLabel !== "unavailable"
    ? releaseData.release.publishedAtLabel
    : null;

function detectOS(): OS {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || "").toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux") && !ua.includes("android")) return "linux";
  if (ua.includes("mac") || platform.includes("mac")) {
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
      <span className="text-base font-semibold leading-tight">
        {button.label}
      </span>
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
            <a
              href={CLOUD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[#FF5800]"
            >
              Cloud
            </a>
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
          <div className="flex flex-wrap gap-3 pt-2">
            <a
              href={CLOUD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center rounded-md bg-[#FF5800] px-5 text-sm font-semibold text-black transition-colors hover:bg-white"
            >
              Open in Cloud
            </a>
            <a
              href="#download"
              className="inline-flex min-h-11 items-center rounded-md border border-white/15 px-5 text-sm font-semibold text-white/85 transition-colors hover:border-white/40 hover:bg-white/10 hover:text-white"
            >
              Download
            </a>
          </div>
        </section>

        <section id="download" className="mt-16 scroll-mt-8">
          <div className="mb-6 flex items-baseline justify-between">
            <div className="flex flex-col gap-1">
              <h2 className="text-2xl font-semibold">Download</h2>
              {RELEASE_TAG_LABEL ? (
                <p className="text-xs text-white/50">
                  Latest:{" "}
                  <a
                    href={releaseData.release.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-white/80 transition-colors hover:text-[#FF5800]"
                  >
                    {RELEASE_TAG_LABEL}
                  </a>
                  {RELEASE_PUBLISHED_LABEL
                    ? ` · ${RELEASE_PUBLISHED_LABEL}`
                    : null}
                </p>
              ) : null}
            </div>
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
