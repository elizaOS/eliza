/**
 * Metadata synchronizer for homepage title and social preview tags.
 *
 * Static markup in `index.html` provides pre-React fallback values; once React
 * mounts, this component replaces them with active-language strings.
 */
import { useEffect } from "react";
import { useT } from "@/providers/I18nProvider";

export function DocumentMetaManager(): null {
  const t = useT();

  useEffect(() => {
    if (typeof document === "undefined") return;
    const routePath = window.location.pathname.replace(/\/+$/, "") || "/";
    const isOrangePaper = ["/orange-paper", "/plan"].includes(routePath);
    const orangePaperTitle = `${t("homepage_eliza.orangePaper.title", {
      defaultValue: "Own your intelligence.",
    })} | elizaOS`;
    const orangePaperDescription = t("homepage_eliza.orangePaper.dek", {
      defaultValue:
        "Bitcoin gave you sovereign money. elizaOS gives you a sovereign mind.",
    });
    const title = isOrangePaper
      ? orangePaperTitle
      : t("homepage_eliza.meta.sovereignTitle", {
          defaultValue: "elizaOS | Sovereign intelligence",
        });
    const description = isOrangePaper
      ? orangePaperDescription
      : t("homepage_eliza.meta.sovereignDescription", {
          defaultValue:
            "The open OS for private, persistent agents. One agent, every surface, on infrastructure you control.",
        });
    const ogTitle = isOrangePaper
      ? orangePaperTitle
      : t("homepage_eliza.meta.sovereignOgTitle", {
          defaultValue:
            "Bitcoin gave you sovereign money. elizaOS gives you a sovereign mind.",
        });
    const ogDescription = isOrangePaper
      ? description
      : t("homepage_eliza.meta.sovereignOgDescription", {
          defaultValue:
            "One open agent operating system. Private, persistent, and portable.",
        });
    const ogImageAlt = t("homepage_eliza.meta.sovereignOgImageAlt", {
      defaultValue: "elizaOS",
    });

    document.title = title;

    const setMeta = (selector: string, value: string) => {
      const el = document.head.querySelector<HTMLMetaElement>(selector);
      if (el) el.content = value;
    };

    setMeta('meta[name="description"]', description);
    setMeta('meta[property="og:title"]', ogTitle);
    setMeta('meta[property="og:description"]', ogDescription);
    setMeta('meta[property="og:image:alt"]', ogImageAlt);
    setMeta('meta[name="twitter:title"]', ogTitle);
    setMeta('meta[name="twitter:description"]', ogDescription);
  }, [t]);

  return null;
}
