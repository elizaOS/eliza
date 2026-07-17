/** Route-aware metadata synchronizer for public homepage pages. */
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";

export function DocumentMetaManager(): null {
  const t = useT();
  const location = useLocation();
  useEffect(() => {
    if (typeof document === "undefined") return;
    const rawPath = location.pathname;
    const normalizedPath =
      rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : "/";
    if (rawPath !== normalizedPath) {
      window.history.replaceState(
        window.history.state,
        "",
        `${normalizedPath}${window.location.search}${window.location.hash}`,
      );
    }
    const isPaper =
      normalizedPath === "/orange-paper" || normalizedPath === "/plan";
    const title = isPaper
      ? t("homepage_eliza.orangePaper.metaTitle", {
          defaultValue: "The Orange Paper | Eliza",
        })
      : t("homepage_eliza.meta.title", {
          defaultValue: "Eliza | The agent that belongs to you",
        });
    const description = isPaper
      ? t("homepage_eliza.orangePaper.metaDescription", {
          defaultValue:
            "The case for an open, private agent that belongs to you.",
        })
      : t("homepage_eliza.meta.description", {
          defaultValue:
            "One agent. Every device. Your context stays yours. Open source, local-first, and cloud optional.",
        });
    document.title = title;
    const setMeta = (selector: string, value: string) => {
      const element = document.head.querySelector<HTMLMetaElement>(selector);
      if (element) element.content = value;
    };
    setMeta('meta[name="description"]', description);
    setMeta('meta[property="og:title"]', title);
    setMeta('meta[property="og:description"]', description);
    setMeta(
      'meta[property="og:image:alt"]',
      isPaper
        ? t("homepage_eliza.orangePaper.metaImageAlt", {
            defaultValue: "The Orange Paper by Eliza",
          })
        : t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" }),
    );
    setMeta(
      'meta[property="og:url"]',
      `https://eliza.app${normalizedPath === "/" ? "/" : normalizedPath}`,
    );
    setMeta('meta[name="twitter:title"]', title);
    setMeta('meta[name="twitter:description"]', description);
    let canonical = document.head.querySelector<HTMLLinkElement>(
      'link[rel="canonical"]',
    );
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = `https://eliza.app${normalizedPath === "/" ? "/" : normalizedPath}`;
  }, [location.pathname, t]);
  return null;
}
