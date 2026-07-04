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
    const title = t("homepage_eliza.meta.title", {
      defaultValue: "Eliza — your agent, everywhere",
    });
    const description = t("homepage_eliza.meta.description", {
      defaultValue:
        "Eliza — your agent, everywhere. Desktop, mobile, and cloud, all running the same Eliza.",
    });
    const ogTitle = t("homepage_eliza.meta.ogTitle", {
      defaultValue: "Eliza — your agent, everywhere",
    });
    const ogDescription = t("homepage_eliza.meta.ogDescription", {
      defaultValue: "Desktop, mobile, and cloud, all running the same Eliza.",
    });
    const ogImageAlt = t("homepage_eliza.meta.ogImageAlt", {
      defaultValue: "Eliza",
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
