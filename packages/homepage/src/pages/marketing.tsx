/**
 * Sovereign elizaOS homepage port with production release download affordances.
 */
import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import { ArrowRight, BadgeCheck, ExternalLink, Package } from "lucide-react";
import { useEffect } from "react";
import type { OsArtifact, ReleaseDataRelease } from "@/generated/release-data";
import { releaseData } from "@/generated/release-data";
import { selectEffectiveRelease } from "@/lib/release-selection";
import { useT } from "@/providers/I18nProvider";

const MARK = "/brand/logos/logo_orange_nobg.svg";
const githubUrl = EXTERNAL_URLS.github;
const releaseFallbackUrl = `${githubUrl}/releases`;

const primaryDownloadIds = [
  "macos-arm64",
  "macos-x64",
  "windows-x64",
  "linux-x64",
  "linux-deb",
  "android-apk",
] as const;

type DownloadId = (typeof primaryDownloadIds)[number];

const FALLBACK_LABEL_KEYS: Record<DownloadId, string> = {
  "macos-arm64": "homepage_eliza.marketing.fallbackMacosArm64",
  "macos-x64": "homepage_eliza.marketing.fallbackMacosX64",
  "windows-x64": "homepage_eliza.marketing.fallbackWindowsX64",
  "linux-x64": "homepage_eliza.marketing.fallbackLinuxX64",
  "linux-deb": "homepage_eliza.marketing.fallbackLinuxDeb",
  "android-apk": "homepage_eliza.marketing.fallbackAndroidApk",
};

const FALLBACK_LABEL_DEFAULTS: Record<DownloadId, string> = {
  "macos-arm64": "macOS (Apple Silicon)",
  "macos-x64": "macOS (Intel)",
  "windows-x64": "Windows",
  "linux-x64": "Linux",
  "linux-deb": "Ubuntu / Debian",
  "android-apk": "Android APK",
};

const PLATFORM_DESCRIPTION_KEYS: Record<DownloadId, string> = {
  "macos-arm64": "homepage_eliza.marketing.descMacosArm64",
  "macos-x64": "homepage_eliza.marketing.descMacosX64",
  "windows-x64": "homepage_eliza.marketing.descWindowsX64",
  "linux-x64": "homepage_eliza.marketing.descLinuxX64",
  "linux-deb": "homepage_eliza.marketing.descLinuxDeb",
  "android-apk": "homepage_eliza.marketing.descAndroidApk",
};

const PLATFORM_DESCRIPTION_DEFAULTS: Record<DownloadId, string> = {
  "macos-arm64": "For M1, M2, M3, and newer Apple Silicon Macs.",
  "macos-x64": "For Intel Macs.",
  "windows-x64": "For 64-bit Windows PCs.",
  "linux-x64": "For 64-bit Linux desktops.",
  "linux-deb": "Ubuntu, Debian, Pop_OS, and derivatives, apt-installable.",
  "android-apk": "Direct APK sideload while Play Store review is pending.",
};

function formatOsArtifactSize(sizeBytes: number | null): string | null {
  if (!sizeBytes || sizeBytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function stripVisibleDashes(value: string): string {
  return value.split("\u2014").join("-");
}

export default function MarketingPage() {
  const t = useT();
  const effectiveRelease = selectEffectiveRelease(releaseData);
  const effectiveDownloads = effectiveRelease.downloads;
  const osArtifacts = releaseData.osArtifacts.filter(
    (artifact): artifact is OsArtifact & { downloadUrl: string } =>
      Boolean(artifact.downloadUrl),
  );
  const downloads = primaryDownloadIds.map((id) => {
    const releaseDownload = effectiveDownloads.find(
      (download) => download.id === id,
    );
    return {
      id,
      label:
        releaseDownload?.label ??
        t(FALLBACK_LABEL_KEYS[id], {
          defaultValue: FALLBACK_LABEL_DEFAULTS[id],
        }),
      href: releaseDownload?.url ?? releaseFallbackUrl,
      detail: releaseDownload
        ? t("homepage_eliza.marketing.releaseDetail", {
            defaultValue: "{{note}} · {{sizeLabel}}",
            note: releaseDownload.note,
            sizeLabel: releaseDownload.sizeLabel,
          })
        : t("homepage_eliza.marketing.releaseFallbackDetail", {
            defaultValue: "Release page",
          }),
      meta: releaseDownload
        ? t("homepage_eliza.marketing.releaseFromMeta", {
            defaultValue: "From {{tag}}",
            tag: releaseDownload.releaseTagName,
          })
        : t("homepage_eliza.marketing.releaseFallbackMeta", {
            defaultValue: "Opens release page",
          }),
      fileName:
        releaseDownload?.fileName ??
        t("homepage_eliza.marketing.releaseFallbackFile", {
          defaultValue: "Latest release",
        }),
      description: t(PLATFORM_DESCRIPTION_KEYS[id], {
        defaultValue: PLATFORM_DESCRIPTION_DEFAULTS[id],
      }),
    };
  });

  useEffect(() => {
    document.title = t("homepage_eliza.meta.title", {
      defaultValue: "elizaOS: the OS for sovereign agent devices",
    });
    const description = t("homepage_eliza.meta.description", {
      defaultValue:
        "One open agent operating system. No telemetry. No attention economy. Starting with a private phone built for government and enterprise.",
    });
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", description);
    document.querySelector('meta[property="og:title"]')?.setAttribute(
      "content",
      t("homepage_eliza.meta.ogTitle", {
        defaultValue: "elizaOS: the OS for sovereign agent devices",
      }),
    );
    document
      .querySelector('meta[property="og:description"]')
      ?.setAttribute("content", description);
  }, [t]);

  return (
    <div className="sovereign-page">
      <a href="#main" className="sovereign-skip">
        {t("homepage_eliza.common.skipToContent", {
          defaultValue: "Skip to content",
        })}
      </a>
      <div className="sovereign-frame" aria-hidden="true" />
      <nav
        className="sovereign-nav"
        aria-label={t("homepage_eliza.marketing.navProducts", {
          defaultValue: "elizaOS",
        })}
      >
        <div className="sovereign-wrap">
          <a className="sovereign-brand" href="/">
            <img src={MARK} alt="" draggable={false} />
            <span>
              eliza<b>OS</b>
            </span>
          </a>
          <div className="sovereign-meta">
            {t("homepage_eliza.marketing.navMeta", {
              defaultValue: "OS for agent devices",
            })}
          </div>
        </div>
      </nav>

      <main id="main">
        <header className="sovereign-hero">
          <img className="sovereign-hero-mark" src={MARK} alt="" />
          <div className="sovereign-wrap">
            <div className="sovereign-tagrow">
              <span className="sovereign-bar" />
              <span>
                {t("homepage_eliza.marketing.tagOpenSource", {
                  defaultValue: "Open source",
                })}
              </span>
              <span>
                {t("homepage_eliza.marketing.tagCypherpunk", {
                  defaultValue: "Cypherpunk",
                })}
              </span>
              <span>
                {t("homepage_eliza.marketing.tagSovereign", {
                  defaultValue: "Sovereign",
                })}
              </span>
              <span>
                {t("homepage_eliza.marketing.tagAgentNative", {
                  defaultValue: "Agent-native",
                })}
              </span>
            </div>
            <h1>
              {t("homepage_eliza.marketing.heroTitlePrefix", {
                defaultValue: "The OS for ",
              })}
              <em>
                {t("homepage_eliza.marketing.heroTitleEmphasis", {
                  defaultValue: "sovereign",
                })}
              </em>
              {t("homepage_eliza.marketing.heroTitleSuffix", {
                defaultValue: " agent devices.",
              })}
            </h1>
            <p className="sovereign-lede">
              {t("homepage_eliza.marketing.heroLede", {
                defaultValue:
                  "One open agent operating system that runs your life and answers to no one else. No telemetry. No attention economy. Cypherpunk to the core: your keys, your data, your agent, your machine. It gives you your time back instead of stealing it, on every device you own.",
              })}
            </p>
            <div className="sovereign-cta">
              <a className="sovereign-btn sovereign-btn-primary" href="#deal">
                {t("homepage_eliza.marketing.ctaDeal", {
                  defaultValue: "The deal ↓",
                })}
              </a>
              <a
                className="sovereign-btn sovereign-btn-secondary"
                href="#stack"
              >
                {t("homepage_eliza.marketing.ctaHowItWorks", {
                  defaultValue: "How it works",
                })}
              </a>
              <a
                className="sovereign-btn sovereign-btn-secondary"
                href="#download"
              >
                {t("homepage_eliza.marketing.ctaDownload", {
                  defaultValue: "Download",
                })}
              </a>
            </div>
          </div>
        </header>

        <Ticker />
        <Facts />
        <WhySection />
        <WedgeSection />
        <StackSection />
        <DealSection />
        <DownloadSection
          downloads={downloads}
          effectiveRelease={effectiveRelease}
          osArtifacts={osArtifacts}
        />
      </main>

      <footer className="sovereign-footer">
        <div className="sovereign-wrap">
          <img className="sovereign-footer-mark" src={MARK} alt="elizaOS" />
          <div className="sovereign-label sovereign-label-centered">
            <span>
              {t("homepage_eliza.marketing.footerMissionLabel", {
                defaultValue: "The mission",
              })}
            </span>
          </div>
          <h2>
            {t("homepage_eliza.marketing.footerMissionTitle", {
              defaultValue: "Every person deserves access to intelligence.",
            })}
          </h2>
          <p>
            {t("homepage_eliza.marketing.footerMissionBody", {
              defaultValue:
                "And their time back, not stolen. Cypherpunk roots, open source forever: cryptography and agency for the individual, against surveillance and capture. We play to win, but we win by giving people control, not by taking their attention.",
            })}
          </p>
          <div className="sovereign-cta sovereign-cta-centered">
            <a className="sovereign-btn sovereign-btn-primary" href={githubUrl}>
              github.com/elizaOS
            </a>
            <a
              className="sovereign-btn sovereign-btn-secondary"
              href="/orange-paper"
            >
              {t("homepage_eliza.marketing.ctaOrangePaper", {
                defaultValue: "Read the Orange Paper →",
              })}
            </a>
          </div>
          <p className="sovereign-fine">
            {t("homepage_eliza.marketing.footerFine", {
              defaultValue:
                "elizaOS · open-source agent operating system · Foundation + PBC · figures from public market research",
            })}
          </p>
        </div>
      </footer>
    </div>
  );
}

function Ticker() {
  const t = useT();
  const messages = [
    {
      id: "privacy",
      text: t("homepage_eliza.marketing.tickerPrivacy", {
        defaultValue:
          "PRIVACY IS NECESSARY FOR AN OPEN SOCIETY IN THE ELECTRONIC AGE",
      }),
    },
    {
      id: "keys",
      text: t("homepage_eliza.marketing.tickerKeys", {
        defaultValue: "YOUR KEYS · YOUR DATA · YOUR AGENT · YOUR MACHINE",
      }),
    },
    {
      id: "permission",
      text: t("homepage_eliza.marketing.tickerPermission", {
        defaultValue: "WE DON'T ASK PERMISSION TO OWN OUR OWN MINDS",
      }),
    },
    {
      id: "open-source",
      text: t("homepage_eliza.marketing.tickerOpenSource", {
        defaultValue: "OPEN SOURCE OR IT DIDN'T HAPPEN",
      }),
    },
  ];
  const tickerItems = [
    { id: "primary", messages },
    { id: "repeat", messages },
  ].flatMap(({ id: copyId, messages: copyMessages }) =>
    copyMessages.flatMap(({ id, text }) => [
      { id: `${copyId}-${id}`, text },
      { id: `${copyId}-${id}-separator`, text: "·" },
    ]),
  );
  return (
    <div className="sovereign-ticker" data-marquee>
      <div>
        {tickerItems.map(({ id, text }) => (
          <span key={id}>{text}</span>
        ))}
      </div>
    </div>
  );
}

function Facts() {
  const t = useT();
  const facts = [
    [
      t("homepage_eliza.marketing.factGithubNumber", {
        defaultValue: "18k★",
      }),
      t("homepage_eliza.marketing.factGithubLabel", {
        defaultValue: "GitHub stars · live community",
      }),
    ],
    [
      t("homepage_eliza.marketing.factMarketNumber", {
        defaultValue: "~60%",
      }),
      t("homepage_eliza.marketing.factMarketLabel", {
        defaultValue: "of the Web3 agent-dev market",
      }),
    ],
    [
      t("homepage_eliza.marketing.factTeamsNumber", {
        defaultValue: "1,000+",
      }),
      t("homepage_eliza.marketing.factTeamsLabel", {
        defaultValue: "teams building on elizaOS",
      }),
    ],
    [
      t("homepage_eliza.marketing.factFormFactorsNumber", {
        defaultValue: "∞",
      }),
      t("homepage_eliza.marketing.factFormFactorsLabel", {
        defaultValue: "form factors · one OS",
      }),
    ],
  ];
  return (
    <div className="sovereign-facts">
      <div className="sovereign-wrap">
        {facts.map(([number, label]) => (
          <div className="sovereign-fact" key={label}>
            <div>{number}</div>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ no, label }: { no: string; label: string }) {
  return (
    <div className="sovereign-label">
      <span className="sovereign-no">{no}</span>
      <span>{label}</span>
    </div>
  );
}

function WhySection() {
  const t = useT();
  return (
    <section id="why" className="sovereign-section">
      <div className="sovereign-wrap">
        <SectionLabel
          no="01"
          label={t("homepage_eliza.marketing.whyLabel", {
            defaultValue: "Why now",
          })}
        />
        <h2>
          {t("homepage_eliza.marketing.whyTitleLine1", {
            defaultValue: "Everyone built a gadget.",
          })}
          <br />
          {t("homepage_eliza.marketing.whyTitleLine2", {
            defaultValue: "We build the layer underneath.",
          })}
        </h2>
        <p className="sovereign-sub">
          {t("homepage_eliza.marketing.whyBody", {
            defaultValue:
              "AI can finally do things, not just chat. The winning layer is an operating system: persistent, form-factor-agnostic, open. That layer belongs to whoever owns your data, or it's open. We build the open one.",
          })}
        </p>
        <div className="sovereign-split">
          <article className="sovereign-cell sovereign-cell-dark">
            <h3>
              <span>✕</span>{" "}
              {t("homepage_eliza.marketing.gadgetGraveyardTitle", {
                defaultValue: "The gadget graveyard",
              })}
            </h3>
            <p>
              {t("homepage_eliza.marketing.gadgetGraveyardBody", {
                defaultValue:
                  "Rabbit R1: mass returns, missed payroll. Humane: returns outpaced sales, devices bricked. Meta bought Limitless, Amazon bought Bee. A standalone gadget that replaces your phone is a kill-zone. We don't build there.",
              })}
            </p>
          </article>
          <article className="sovereign-cell">
            <h3>
              <span>→</span>{" "}
              {t("homepage_eliza.marketing.osPlayTitle", {
                defaultValue: "The OS play",
              })}
            </h3>
            <p>
              {t("homepage_eliza.marketing.osPlayBody", {
                defaultValue:
                  "Be the OS the devices run, not the device. Phone, desktop, USB-boot, Raspberry Pi, home devices. Hardware is the wedge; the OS, community and cloud are the moat. The Red Hat playbook for the agent era.",
              })}
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}

function WedgeSection() {
  const t = useT();
  const wedges = [
    {
      idx: t("homepage_eliza.marketing.wedgeOneIndex", {
        defaultValue: "WEDGE 01",
      }),
      title: t("homepage_eliza.marketing.wedgeOneTitle", {
        defaultValue: "Sovereign & government devices",
      }),
      body: t("homepage_eliza.marketing.wedgeOneBody", {
        defaultValue:
          "Telemetry-stripped private phones for gov and regulated enterprise. Compliance-gated, sovereignty-first: the one lane the giants can't enter.",
      }),
      pill: t("homepage_eliza.marketing.wedgeOnePill", {
        defaultValue: "the beachhead",
      }),
    },
    {
      idx: t("homepage_eliza.marketing.wedgeTwoIndex", {
        defaultValue: "WEDGE 02",
      }),
      title: t("homepage_eliza.marketing.wedgeTwoTitle", {
        defaultValue: "Overwhelmed & neurodivergent lives",
      }),
      body: t("homepage_eliza.marketing.wedgeTwoBody", {
        defaultValue:
          "~30M US adults whose lives are hard to manage. $6B+ TAM, high willingness to pay, a segment Apple and Google won't target. Peer, not savior.",
      }),
      pill: t("homepage_eliza.marketing.wedgeTwoPill", {
        defaultValue: "consumer widen",
      }),
    },
    {
      idx: t("homepage_eliza.marketing.wedgeThreeIndex", {
        defaultValue: "WEDGE 03",
      }),
      title: t("homepage_eliza.marketing.wedgeThreeTitle", {
        defaultValue: "The open-source funnel",
      }),
      body: t("homepage_eliza.marketing.wedgeThreeBody", {
        defaultValue:
          "An 18k-star community: distribution engine, contributor base, and free QA army. The layer that feeds the enterprise business.",
      }),
      pill: t("homepage_eliza.marketing.wedgeThreePill", {
        defaultValue: "distribution",
      }),
    },
  ];
  return (
    <section id="wedge" className="sovereign-section">
      <div className="sovereign-wrap">
        <SectionLabel
          no="02"
          label={t("homepage_eliza.marketing.wedgeLabel", {
            defaultValue: "The beachhead",
          })}
        />
        <h2>
          {t("homepage_eliza.marketing.wedgeTitle", {
            defaultValue: "Start where Big Tech can't follow.",
          })}
        </h2>
        <p className="sovereign-sub">
          {t("homepage_eliza.marketing.wedgeBody", {
            defaultValue:
              "Apple and Google's entire business model is telemetry. They cannot credibly ship a private, no-tracking sovereign device. The cypherpunks were right: privacy in an open society requires it in software. That's exactly where elizaOS wins first, and it's real, not a slide.",
          })}
        </p>
        <div className="sovereign-wedge">
          {wedges.map(({ idx, title, body, pill }, index) => (
            <article
              className={index === 0 ? "sovereign-w hero" : "sovereign-w"}
              key={idx}
            >
              <div className="sovereign-idx">{idx}</div>
              <h3>{title}</h3>
              <p>{body}</p>
              <span>{pill}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function StackSection() {
  const t = useT();
  const layers = [
    {
      idx: "01",
      title: t("homepage_eliza.marketing.stackLayerOneTitle", {
        defaultValue: "Companion app",
      }),
      body: t("homepage_eliza.marketing.stackLayerOneBody", {
        defaultValue: "The interface, on the devices you already carry.",
      }),
    },
    {
      idx: "02",
      title: t("homepage_eliza.marketing.stackLayerTwoTitle", {
        defaultValue: "Always-present relay",
      }),
      body: t("homepage_eliza.marketing.stackLayerTwoBody", {
        defaultValue:
          "Ambient capture and memory, as software, running on hardware you already own. No wearable to manufacture, no kill-zone.",
      }),
    },
    {
      idx: "03",
      title: t("homepage_eliza.marketing.stackLayerThreeTitle", {
        defaultValue: "elizaOS runtime",
      }),
      body: t("homepage_eliza.marketing.stackLayerThreeBody", {
        defaultValue:
          "The open agent OS. Runs anywhere: phone, USB-boot, Pi, robots, home devices. The default OS for agent devices.",
      }),
    },
    {
      idx: "04",
      title: t("homepage_eliza.marketing.stackLayerFourTitle", {
        defaultValue: "Cloud, hosted or self-hosted",
      }),
      body: t("homepage_eliza.marketing.stackLayerFourBody", {
        defaultValue:
          "Where the agent lives and persists. Self-host free; hosted subscription for convenience. Our compute cost edge makes the margins real.",
      }),
    },
  ];
  return (
    <section id="stack" className="sovereign-section">
      <div className="sovereign-wrap">
        <SectionLabel
          no="03"
          label={t("homepage_eliza.marketing.stackLabel", {
            defaultValue: "The product",
          })}
        />
        <h2>
          {t("homepage_eliza.marketing.stackTitleLine1", {
            defaultValue: "One agent. Every device.",
          })}
          <br />
          {t("homepage_eliza.marketing.stackTitleLine2", {
            defaultValue: "Your data stays yours.",
          })}
        </h2>
        <p className="sovereign-sub">
          {t("homepage_eliza.marketing.stackBody", {
            defaultValue:
              "elizaOS delivers a persistent personal agent as a system, not an app you open, a presence that's always there. Free and open to self-host. Hosted convenience and enterprise support are the business.",
          })}
        </p>
        <div className="sovereign-stack">
          {layers.map(({ idx, title, body }, index) => (
            <article
              className={
                index === 3 ? "sovereign-layer highlight" : "sovereign-layer"
              }
              key={idx}
            >
              <span>{idx}</span>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function DealSection() {
  const t = useT();
  const steps = [
    {
      idx: "1",
      title: t("homepage_eliza.marketing.dealStepOneTitle", {
        defaultValue: "Land the sovereign wedge",
      }),
      body: t("homepage_eliza.marketing.dealStepOneBody", {
        defaultValue:
          "Private, telemetry-stripped devices for government and regulated enterprise, where an open, auditable, no-tracking OS isn't a preference, it's a procurement requirement. The one lane the giants structurally can't enter.",
      }),
    },
    {
      idx: "2",
      title: t("homepage_eliza.marketing.dealStepTwoTitle", {
        defaultValue: "Widen to every device",
      }),
      body: t("homepage_eliza.marketing.dealStepTwoBody", {
        defaultValue:
          "The same OS runs everywhere: phone, desktop, USB-boot, Pi, home devices, robots. The open-source community carries it; the hosted cloud monetizes it. One agent, your data, everywhere.",
      }),
    },
    {
      idx: "3",
      title: t("homepage_eliza.marketing.dealStepThreeTitle", {
        defaultValue: "Own the layer",
      }),
      body: t("homepage_eliza.marketing.dealStepThreeBody", {
        defaultValue:
          "Become the default operating system for the agent era, the trusted, open, sovereign base that everything else is built on. Red Hat economics on an open foundation. Access to intelligence for everyone.",
      }),
    },
  ];
  return (
    <section id="deal" className="sovereign-section sovereign-dealsec">
      <div className="sovereign-wrap">
        <SectionLabel
          no="04"
          label={t("homepage_eliza.marketing.dealLabel", {
            defaultValue: "The arc",
          })}
        />
        <h2>
          {t("homepage_eliza.marketing.dealTitle", {
            defaultValue: "The Linux of agent devices.",
          })}
        </h2>
        <p className="sovereign-sub">
          {t("homepage_eliza.marketing.dealBody", {
            defaultValue:
              "First the sovereign wedge, where openness is the requirement, not the pitch. Then every agent device. Open core forever; enterprise support and hosted cloud are the business.",
          })}
        </p>
        <div className="sovereign-deal">
          {steps.map(({ idx, title, body }) => (
            <article className="sovereign-drow" key={idx}>
              <div>{idx}</div>
              <section>
                <h3>{title}</h3>
                <p>{body}</p>
              </section>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function DownloadSection({
  downloads,
  effectiveRelease,
  osArtifacts,
}: {
  downloads: Array<{
    id: string;
    label: string;
    href: string;
    detail: string;
    meta: string;
    fileName: string;
    description: string;
  }>;
  effectiveRelease: ReleaseDataRelease;
  osArtifacts: Array<OsArtifact & { downloadUrl: string }>;
}) {
  const t = useT();
  return (
    <section id="download" className="sovereign-section sovereign-download">
      <div className="sovereign-wrap">
        <SectionLabel
          no="05"
          label={t("homepage_eliza.marketing.downloadsKicker", {
            defaultValue: "Current builds",
          })}
        />
        <h2>
          {t("homepage_eliza.marketing.downloadsH2", {
            defaultValue: "Install the app.",
          })}
        </h2>
        <p className="sovereign-sub">
          {t("homepage_eliza.marketing.downloadsCopy", {
            defaultValue:
              "Release links resolve to the real published GitHub assets. The standalone app is the practical interface while the OS expands across devices.",
          })}
        </p>
        <section
          className="sovereign-release-line"
          aria-label={t("homepage_eliza.marketing.releaseLabel", {
            defaultValue: "Current release",
          })}
        >
          <span>
            {t("homepage_eliza.marketing.releasePill", {
              defaultValue: "Latest release",
            })}
          </span>
          <strong>{effectiveRelease.tagName}</strong>
          <a href={effectiveRelease.url}>
            {t("homepage_eliza.marketing.releaseNotes", {
              defaultValue: "Release notes",
            })}{" "}
            <ExternalLink aria-hidden="true" size={15} />
          </a>
        </section>
        <div className="sovereign-download-grid" data-testid="download-grid">
          {downloads.map((download) => (
            <a
              className="sovereign-download-card"
              href={download.href}
              key={download.id}
            >
              <Package aria-hidden="true" size={18} />
              <span>
                <strong>{download.label}</strong>
                <small>{download.description}</small>
                <small>{download.fileName}</small>
              </span>
              <span>
                <small>{download.detail}</small>
                <small>{download.meta}</small>
              </span>
              <ArrowRight aria-hidden="true" size={18} />
            </a>
          ))}
        </div>
        {osArtifacts.length > 0 ? (
          <section
            className="sovereign-os-artifacts"
            aria-label={t("homepage_eliza.marketing.osArtifactsAria", {
              defaultValue: "OS artifacts",
            })}
          >
            <h3>
              {t("homepage_eliza.marketing.osArtifactsHeading", {
                defaultValue: "OS artifacts",
              })}
            </h3>
            <ul data-testid="os-artifact-list">
              {osArtifacts.map((artifact) => {
                const sizeLabel = formatOsArtifactSize(artifact.sizeBytes);
                const metadata = [
                  t("homepage_eliza.marketing.osArtifactVersion", {
                    defaultValue: "Version {{version}}",
                    version: artifact.version,
                  }),
                  t("homepage_eliza.marketing.osArtifactChannel", {
                    defaultValue: "{{channel}} channel",
                    channel: artifact.channel,
                  }),
                  sizeLabel
                    ? t("homepage_eliza.marketing.osArtifactSize", {
                        defaultValue: "{{size}}",
                        size: sizeLabel,
                      })
                    : null,
                  artifact.requiresHardware
                    ? t("homepage_eliza.marketing.osArtifactHardware", {
                        defaultValue: "Requires {{hardware}}",
                        hardware: artifact.requiresHardware,
                      })
                    : null,
                  artifact.sha256
                    ? t("homepage_eliza.marketing.osArtifactSha256", {
                        defaultValue: "SHA-256 {{sha256}}",
                        sha256: artifact.sha256,
                      })
                    : null,
                ].filter((value): value is string => Boolean(value));

                return (
                  <li key={artifact.id}>
                    <a
                      data-os-artifact-id={artifact.id}
                      href={artifact.downloadUrl}
                    >
                      <span>
                        <strong>
                          {t(`homepage_eliza.marketing.${artifact.id}.label`, {
                            defaultValue: stripVisibleDashes(artifact.label),
                          })}
                        </strong>
                        <small>
                          {t(
                            `homepage_eliza.marketing.${artifact.id}.description`,
                            {
                              defaultValue: stripVisibleDashes(
                                artifact.description,
                              ),
                            },
                          )}
                        </small>
                      </span>
                      <span>
                        {metadata.map((item) => (
                          <small key={item}>{item}</small>
                        ))}
                      </span>
                      <ArrowRight aria-hidden="true" size={18} />
                    </a>
                    <div>
                      {artifact.checksumUrl ? (
                        <a href={artifact.checksumUrl}>
                          {t("homepage_eliza.marketing.osArtifactChecksum", {
                            defaultValue: "Checksum",
                          })}
                        </a>
                      ) : null}
                      {artifact.releaseNotesUrl ? (
                        <a href={artifact.releaseNotesUrl}>
                          {t("homepage_eliza.marketing.releaseNotes", {
                            defaultValue: "Release notes",
                          })}
                        </a>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        <div className="sovereign-checksum-row">
          {effectiveRelease.checksum ? (
            <a href={effectiveRelease.checksum.url}>
              <BadgeCheck aria-hidden="true" size={16} />
              {t("homepage_eliza.marketing.verifyWith", {
                defaultValue: "Verify with {{file}}",
                file: effectiveRelease.checksum.fileName,
              })}
            </a>
          ) : (
            <span>
              {t("homepage_eliza.marketing.checksumPending", {
                defaultValue: "Checksums publish with release assets.",
              })}
            </span>
          )}
          <a href={effectiveRelease.url}>
            {t("homepage_eliza.marketing.viewAllAssets", {
              defaultValue: "View all assets",
            })}
            <ExternalLink aria-hidden="true" size={15} />
          </a>
        </div>
      </div>
    </section>
  );
}
