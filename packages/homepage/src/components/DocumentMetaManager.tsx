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
    // Deck-era copy uses fresh keys so stale locale translations of the old
    // marketing copy cannot override the current messaging.
    const description = t("homepage_eliza.meta.deckDescription", {
      defaultValue:
        "There’s nothing wrong with you. You’re just overwhelmed. Eliza manages your digital life so you can live your real one.",
    });
    const ogTitle = t("homepage_eliza.meta.deckOgTitle", {
      defaultValue: "Eliza — you’re just overwhelmed",
    });
    const ogDescription = t("homepage_eliza.meta.deckOgDescription", {
      defaultValue:
        "Eliza manages your digital life so you can live your real one.",
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
