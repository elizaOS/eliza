// Browser-pure stand-in for state/TranslationContext.hooks in the onboarding
// bundle. The real useTranslation throws without a TranslationProvider; the
// harness just renders the English defaultValues (kept in sync with en.json),
// interpolating {{vars}} the same way i18next would.
function interpolate(text: string, opts?: Record<string, unknown>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, key: string) =>
    opts && opts[key] != null ? String(opts[key]) : "",
  );
}

export function useTranslation() {
  return {
    t: (key: string, opts?: { defaultValue?: string } & Record<string, unknown>) =>
      interpolate(
        opts && typeof opts.defaultValue === "string" ? opts.defaultValue : key,
        opts,
      ),
    language: "en" as const,
  };
}
