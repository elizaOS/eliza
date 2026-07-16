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
      defaultValue: "elizaOS: the OS for sovereign agent devices",
    });
    const description = t("homepage_eliza.meta.description", {
      defaultValue:
        "One open agent operating system. No telemetry. No attention economy. Starting with a private phone built for government and enterprise.",
    });
    const ogTitle = t("homepage_eliza.meta.ogTitle", {
      defaultValue: "elizaOS: the OS for sovereign agent devices",
    });
    const ogDescription = t("homepage_eliza.meta.ogDescription", {
      defaultValue:
        "One open agent operating system. No telemetry. No attention economy. Starting with a private phone built for government and enterprise.",
    });
    const ogImageAlt = t("homepage_eliza.meta.ogImageAlt", {
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
