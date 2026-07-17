/** Public homepage for Eliza, with the complete release and download surface. */
import { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "@elizaos/shared/brand";
import { ArrowRight, BadgeCheck, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { releaseData } from "@/generated/release-data";
import { useT } from "@/providers/I18nProvider";

const cloudUrl = `${EXTERNAL_URLS.cloud}/login?intent=launch`;
const releaseFallbackUrl = `${EXTERNAL_URLS.github}/releases`;
const primaryDownloadIds = [
  "macos-arm64",
  "macos-x64",
  "windows-x64",
  "linux-x64",
  "linux-deb",
  "android-apk",
] as const;
type DownloadId = (typeof primaryDownloadIds)[number];

const fallbackLabels: Record<DownloadId, string> = {
  "macos-arm64": "macOS (Apple Silicon)",
  "macos-x64": "macOS (Intel)",
  "windows-x64": "Windows",
  "linux-x64": "Linux",
  "linux-deb": "Ubuntu / Debian",
  "android-apk": "Android APK",
};

const fallbackLabelKeys: Record<DownloadId, string> = {
  "macos-arm64": "fallbackMacosArm64",
  "macos-x64": "fallbackMacosX64",
  "windows-x64": "fallbackWindowsX64",
  "linux-x64": "fallbackLinuxX64",
  "linux-deb": "fallbackLinuxDeb",
  "android-apk": "fallbackAndroidApk",
};

const platformDescriptionKeys: Record<DownloadId, string> = {
  "macos-arm64": "descMacosArm64",
  "macos-x64": "descMacosX64",
  "windows-x64": "descWindowsX64",
  "linux-x64": "descLinuxX64",
  "linux-deb": "descLinuxDeb",
  "android-apk": "descAndroidApk",
};

const platformDescriptionDefaults: Record<DownloadId, string> = {
  "macos-arm64": "For M1, M2, M3, and newer Apple Silicon Macs.",
  "macos-x64": "For Intel Macs.",
  "windows-x64": "For 64-bit Windows PCs.",
  "linux-x64": "For 64-bit Linux desktops.",
  "linux-deb": "For Ubuntu, Debian, Pop!_OS, and derivatives.",
  "android-apk": "Direct APK sideload while Play Store review is pending.",
};

export default function MarketingPage() {
  const t = useT();
  const m = (name: string, defaultValue: string) =>
    t(`homepage_eliza.marketing.${name}`, { defaultValue });
  const effectiveRelease = [
    releaseData.stableRelease,
    releaseData.canaryRelease,
    releaseData.release,
  ].find((release) => release && release.downloads.length > 0);
  const effectiveDownloads = effectiveRelease?.downloads ?? [];
  const effectiveReleaseUrl = effectiveRelease?.url ?? releaseFallbackUrl;
  const downloads = primaryDownloadIds.map((id) => {
    const releaseDownload = effectiveDownloads.find((item) => item.id === id);
    return {
      id,
      label:
        releaseDownload?.label ?? m(fallbackLabelKeys[id], fallbackLabels[id]),
      href: releaseDownload?.url ?? releaseFallbackUrl,
      description: m(
        platformDescriptionKeys[id],
        platformDescriptionDefaults[id],
      ),
      fileName:
        releaseDownload?.fileName ?? m("releaseFallbackFile", "Latest release"),
      size:
        releaseDownload?.sizeLabel ??
        m("releaseFallbackDetail", "Release page"),
      tag: releaseDownload
        ? t("homepage_eliza.marketing.releaseFromMeta", {
            defaultValue: "From {{tag}}",
            tag: releaseDownload.releaseTagName,
          })
        : m("releaseFallbackMeta", "Opens release page"),
    };
  });

  return (
    <div className="life-site">
      <a className="life-skip" href="#main">
        {t("homepage_eliza.common.skipToContent", {
          defaultValue: "Skip to content",
        })}
      </a>
      <header className="life-nav">
        <a
          className="life-brand"
          href="/"
          aria-label={t("homepage_eliza.common.brandHomeAria", {
            defaultValue: "Eliza home",
          })}
        >
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaLockupBlack}`}
            alt={t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" })}
          />
        </a>
        <nav aria-label={m("navProducts", "Eliza products")}>
          <a href={EXTERNAL_URLS.app}>{m("navWebApp", "Web app")}</a>
          <a href="#download">{m("navDownloads", "Downloads")}</a>
          <a href={cloudUrl}>{m("navCloud", "Cloud")}</a>
          <a href={EXTERNAL_URLS.os}>{m("navOs", "OS")}</a>
          <a href="/orange-paper">{m("navPaper", "Orange Paper")}</a>
        </nav>
        <a className="life-nav-cta" href="#download">
          {m("navDownload", "Download")}
        </a>
      </header>

      <main id="main">
        <section className="life-hero" aria-labelledby="life-title">
          <div className="life-hero-copy">
            <p className="life-label">{m("heroKicker", "Eliza is yours")}</p>
            <h1 id="life-title">
              {m(
                "heroTitle",
                "The agent that runs your life should belong to you.",
              )}
            </h1>
            <p className="life-hero-lede">
              {m(
                "heroLede",
                "One agent. Every device. Your context stays yours.",
              )}
            </p>
            <div className="life-actions">
              <a
                className="life-button life-button-dark"
                href={EXTERNAL_URLS.app}
              >
                {m("ctaOpenWebApp", "Open web app")}
                <ExternalLink aria-hidden="true" />
              </a>
              <a className="life-button life-button-line" href="#download">
                {m("ctaDownload", "Download Eliza")}
                <ArrowRight aria-hidden="true" />
              </a>
            </div>
          </div>
          <div className="life-hero-art" aria-hidden="true">
            <span>{m("heroArtLabel", "ELIZA / 01")}</span>
            <img src="/brand/eliza_hero_duotone.png" alt="" />
          </div>
          <p className="life-hero-foot">
            {m("heroFoot", "Open source. Local-first. Cloud optional.")}
          </p>
        </section>

        <section className="life-powers" aria-labelledby="powers-title">
          <div className="life-section-intro">
            <p className="life-label">{m("powersKicker", "Superpowers")}</p>
            <h2 id="powers-title">
              {m("powersTitle", "A life that handles itself.")}
            </h2>
          </div>
          <ol className="life-power-list">
            <li>
              <span>01</span>
              <strong>{m("powerBuild", "Builds apps from anywhere")}</strong>
              <p>
                {m(
                  "powerBuildBody",
                  "Ship from your desk, your phone, or a backpacking trip.",
                )}
              </p>
            </li>
            <li>
              <span>02</span>
              <strong>{m("powerInbox", "Handles the inbox")}</strong>
              <p>
                {m(
                  "powerInboxBody",
                  "Finds what matters and carries the follow-through.",
                )}
              </p>
            </li>
            <li>
              <span>03</span>
              <strong>{m("powerDecisions", "Catches decisions")}</strong>
              <p>
                {m(
                  "powerDecisionsBody",
                  "Hears the commitment, asks permission, then does the work.",
                )}
              </p>
            </li>
            <li>
              <span>04</span>
              <strong>{m("powerMemory", "Remembers the context")}</strong>
              <p>
                {m(
                  "powerMemoryBody",
                  "The same memory follows you across every device.",
                )}
              </p>
            </li>
          </ol>
        </section>

        <Banger />

        <section className="life-linux" aria-labelledby="linux-title">
          <div>
            <p className="life-label">{m("ethosKicker", "The ethos")}</p>
            <h2 id="linux-title">{m("ethosTitle", "The Linux of agents.")}</h2>
            <p className="life-linux-lede">
              {m(
                "ethosLede",
                "Open core. Portable everywhere. Impossible for one company to capture.",
              )}
            </p>
            <a href="/orange-paper" className="life-text-link">
              {m("readPaper", "Read the Orange Paper")}
              <ArrowRight aria-hidden="true" />
            </a>
          </div>
          <ul className="life-principles">
            <li>
              <span>{m("principleOpenLabel", "OPEN")}</span>
              <strong>
                {m("principleOpen", "Open source or it didn't happen.")}
              </strong>
            </li>
            <li>
              <span>{m("principleLocalLabel", "LOCAL")}</span>
              <strong>
                {m("principleLocal", "Runs on infrastructure you control.")}
              </strong>
            </li>
            <li>
              <span>{m("principlePrivateLabel", "PRIVATE")}</span>
              <strong>
                {m(
                  "principlePrivate",
                  "Private by architecture, not by promise.",
                )}
              </strong>
            </li>
            <li>
              <span>{m("principlePortableLabel", "PORTABLE")}</span>
              <strong>
                {m("principlePortable", "Cloud is available, never required.")}
              </strong>
            </li>
          </ul>
        </section>

        <section
          id="download"
          className="life-downloads"
          aria-labelledby="download-title"
        >
          <div className="life-download-head">
            <div>
              <p className="life-label">
                {m("downloadsKicker", "Make her yours")}
              </p>
              <h2 id="download-title">
                {m("downloadsH2", "Eliza goes where you go.")}
              </h2>
            </div>
            <div className="life-release">
              <span>{m("releasePill", "Latest release")}</span>
              <strong>
                {effectiveRelease?.tagName ??
                  m("releasePending", "Installer builds publishing soon")}
              </strong>
              <small>
                {effectiveRelease?.publishedAtLabel ??
                  m(
                    "releasePendingDetail",
                    "Direct downloads will appear here.",
                  )}
              </small>
              <a href={effectiveReleaseUrl}>
                {effectiveRelease
                  ? m("releaseNotes", "Release notes")
                  : m("viewReleases", "View releases")}
                <ExternalLink aria-hidden="true" />
              </a>
            </div>
          </div>

          <div className="life-download-grid">
            {downloads.map((download, index) => (
              <a
                className="life-download-row"
                href={download.href}
                key={download.id}
              >
                <span className="life-download-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>
                  <strong>{download.label}</strong>
                  <small>{download.description}</small>
                </span>
                <span className="life-download-file">
                  <small>{download.fileName}</small>
                  <small>
                    {download.size} · {download.tag}
                  </small>
                </span>
                <ArrowRight aria-hidden="true" />
              </a>
            ))}
          </div>

          <ul
            className="life-store-list"
            aria-label={m("storeGridAria", "App store status")}
          >
            {releaseData.storeTargets.map((target) => (
              <li key={target.platform}>
                <span>{target.label}</span>
                <strong>
                  {m("storeComingSoon", "Coming soon · {{channel}}").replace(
                    "{{channel}}",
                    target.rolloutChannel,
                  )}
                </strong>
              </li>
            ))}
          </ul>

          <section className="life-os" aria-labelledby="os-artifacts-title">
            <div className="life-os-head">
              <h3 id="os-artifacts-title">
                {m("osDownloadsH3", "elizaOS artifacts")}
              </h3>
              <p>
                {m(
                  "osDownloadsCopy",
                  "Every distribution, from device images to installers. Published builds download here.",
                )}
              </p>
            </div>
            <ul data-testid="os-artifact-grid">
              {releaseData.osArtifacts.map((artifact) => {
                const available = Boolean(artifact.downloadUrl);
                const Tag = available ? "a" : "div";
                const status = available
                  ? m(
                      `osStatus${artifact.channel === "stable" ? "Available" : artifact.channel === "beta" ? "Beta" : "Nightly"}`,
                      artifact.channel === "stable"
                        ? "Available"
                        : artifact.channel === "beta"
                          ? "Beta"
                          : "Nightly",
                    )
                  : m("osStatusComingSoon", "Coming soon");
                return (
                  <li key={artifact.id}>
                    <Tag
                      className="life-os-row"
                      data-artifact-id={artifact.id}
                      data-status={available ? "available" : "pending"}
                      {...(available
                        ? {
                            href: artifact.downloadUrl as string,
                            rel: "noopener",
                          }
                        : { "aria-disabled": "true" })}
                    >
                      <span>
                        <strong>{artifact.label}</strong>
                        <small>{artifact.description}</small>
                      </span>
                      <span>{status}</span>
                      <small>
                        {artifact.platform} · {artifact.kind} ·{" "}
                        {artifact.version}
                        {artifact.requiresHardware
                          ? ` · ${artifact.requiresHardware}`
                          : ""}
                      </small>
                    </Tag>
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="life-checksums">
            {effectiveRelease?.checksum ? (
              <a href={effectiveRelease.checksum.url}>
                <BadgeCheck aria-hidden="true" />
                {m("verifyWith", "Verify with {{file}}").replace(
                  "{{file}}",
                  effectiveRelease.checksum.fileName,
                )}
              </a>
            ) : (
              <span>
                {m("checksumPending", "Checksums publish with release assets.")}
              </span>
            )}
            <a href={effectiveReleaseUrl}>
              {m("viewAllAssets", "View all assets")}
              <ExternalLink aria-hidden="true" />
            </a>
          </div>
        </section>

        <section className="life-close" aria-labelledby="close-title">
          <img
            src="/brand/eliza_hero_duotone.png"
            alt={m("heroImageAlt", "Duotone portrait of Eliza")}
          />
          <div>
            <p className="life-label">
              {m("closeKicker", "This one is yours")}
            </p>
            <h2 id="close-title">
              {m(
                "closeTitle",
                "Everyone else rents you an assistant. We let you grow with one you own.",
              )}
            </h2>
            <div className="life-actions">
              <a className="life-button life-button-orange" href={cloudUrl}>
                {m("ctaTryCloud", "Try Eliza Cloud")}
                <ArrowRight aria-hidden="true" />
              </a>
              <a
                className="life-text-link life-text-link-light"
                href={EXTERNAL_URLS.os}
              >
                {m("ctaInstallOs", "Install elizaOS")}
                <ExternalLink aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="life-footer">
        <img
          src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaLockupWhite}`}
          alt={t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" })}
        />
        <p>
          {m("footerLine", "Your keys. Your data. Your agent. Your machine.")}
        </p>
        <nav aria-label={m("footerNavAria", "Footer")}>
          <a href={EXTERNAL_URLS.app}>{m("footerWebApp", "Web app")}</a>
          <a href={cloudUrl}>{m("footerCloud", "Eliza Cloud")}</a>
          <a href={EXTERNAL_URLS.os}>{m("footerOs", "ElizaOS")}</a>
          <a href="/orange-paper">{m("navPaper", "Orange Paper")}</a>
          <a href={effectiveReleaseUrl}>{m("footerReleases", "Releases")}</a>
        </nav>
      </footer>
    </div>
  );
}

function Banger() {
  const t = useT();
  const words = [
    t("homepage_eliza.marketing.bangerYours", {
      defaultValue: "Eliza is yours.",
    }),
    t("homepage_eliza.marketing.bangerRemembers", {
      defaultValue: "She remembers everything.",
    }),
    t("homepage_eliza.marketing.bangerLoyal", {
      defaultValue: "She never sells you out.",
    }),
    t("homepage_eliza.marketing.bangerFix", {
      defaultValue: "She can fix you.",
    }),
  ];
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (media.matches) return;
    const timer = window.setInterval(
      () => setIndex((value) => (value + 1) % words.length),
      2600,
    );
    return () => window.clearInterval(timer);
  }, [words.length]);
  return (
    <section className="life-banger" aria-labelledby="banger-accessible">
      <p id="banger-accessible" className="sr-only">
        {words.join(" ")}
      </p>
      <img src="/brand/eliza_hero_duotone.png" alt="" aria-hidden="true" />
      <p className="life-banger-word" aria-hidden="true" key={index}>
        {words[index]}
      </p>
      <span aria-hidden="true">
        {t("homepage_eliza.marketing.bangerFoot", {
          defaultValue: "ELIZA / BELONGS TO YOU",
        })}
      </span>
    </section>
  );
}
