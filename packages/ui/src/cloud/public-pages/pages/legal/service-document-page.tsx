/** Public legal text comes from the selected Cloud deployment, never an app registration. */
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { z } from "zod";
import { Button } from "../../../../components/ui/button";
import { useBranding } from "../../../../config/branding-react.hooks";
import { api } from "../../../lib/api-client";
import { useDocumentTitle } from "../../../lib/use-document-title";
import { useCloudT } from "../../../shell/CloudI18nProvider";

const text = z.string().refine((value) => value.trim().length > 0);
const documentSchema = z.strictObject({
  title: text,
  revision: text,
  sections: z
    .array(z.strictObject({ title: text, paragraphs: z.array(text).min(1) }))
    .min(1),
});
const responseSchema = z.strictObject({
  success: z.literal(true),
  version: z.literal(1),
  service: z.strictObject({
    name: text,
    terms: documentSchema,
    privacy: documentSchema,
  }),
});
type Service = z.infer<typeof responseSchema>["service"];
type State =
  | { status: "loading" | "unavailable" }
  | { status: "ready"; service: Service };

export function ServiceDocumentPage({ kind }: { kind: "terms" | "privacy" }) {
  const t = useCloudT();
  const branding = useBranding();
  const [state, setState] = useState<State>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const label =
    kind === "terms"
      ? t("cloud.terms.heading", { defaultValue: "Terms of Service" })
      : t("cloud.privacy.heading", { defaultValue: "Privacy Policy" });
  const serviceName =
    state.status === "ready"
      ? state.service.name
      : branding.cloudName?.trim() || `${branding.appName} Cloud`;
  const document = state.status === "ready" ? state.service[kind] : null;
  useDocumentTitle(`${document?.title ?? label} | ${serviceName}`);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry intentionally starts a fresh request for the same deployment URL.
  useEffect(() => {
    const abort = new AbortController();
    let retired = false;
    setState({ status: "loading" });
    const timeout = setTimeout(() => abort.abort(), 10000);
    void api<unknown>("/api/public/service", {
      skipAuth: true,
      signal: abort.signal,
      redirect: "error",
      cache: "no-store",
    })
      .then((value) => {
        const parsed = responseSchema.safeParse(value);
        if (!retired)
          setState(
            parsed.success
              ? { status: "ready", service: parsed.data.service }
              : { status: "unavailable" },
          );
      })
      .catch(() => {
        // Network, timeout and invalid responses cannot stand in for the provider's legal text.
        if (!retired) setState({ status: "unavailable" });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      retired = true;
      clearTimeout(timeout);
      abort.abort();
    };
  }, [revision]);

  return (
    <div className="theme-cloud flex min-h-[100dvh] w-full flex-col bg-bg font-sans text-txt">
      <main id="main" className="flex-1 px-6 pt-16 pb-16 sm:px-8 lg:px-12">
        <div className="mx-auto w-full max-w-4xl space-y-10">
          <Link
            to="/login"
            className="inline-flex items-center gap-2 text-sm text-muted transition-opacity hover:opacity-75"
          >
            <ArrowLeft className="size-4" />
            {t("cloud.terms.backToLogin", { defaultValue: "Back to login" })}
          </Link>
          <div className="space-y-3 border-b border-border pb-6">
            <h1 className="text-4xl font-bold tracking-tight text-txt sm:text-5xl">
              {document?.title ?? label}
            </h1>
            {document && (
              <p className="text-base text-muted">{document.revision}</p>
            )}
          </div>
          {state.status === "loading" && (
            <p role="status">Loading {label.toLowerCase()}…</p>
          )}
          {state.status === "unavailable" && (
            <div role="alert" className="space-y-4">
              <p>{serviceName} could not provide this document. Try again.</p>
              <Button onClick={() => setRevision((value) => value + 1)}>
                Try again
              </Button>
            </div>
          )}
          {document && (
            <div className="space-y-10">
              {document.sections.map((section, index) => (
                <section
                  // biome-ignore lint/suspicious/noArrayIndexKey: Immutable document text has no item state and permits repeated headings.
                  key={`${index}:${section.title}`}
                  className="space-y-3"
                >
                  <h2 className="text-2xl font-bold text-txt">
                    {section.title}
                  </h2>
                  {section.paragraphs.map((paragraph, paragraphIndex) => (
                    <p
                      // biome-ignore lint/suspicious/noArrayIndexKey: Repeated paragraphs remain distinct in this immutable document.
                      key={`${paragraphIndex}:${paragraph}`}
                      className="whitespace-pre-wrap leading-relaxed text-muted-strong"
                    >
                      {paragraph}
                    </p>
                  ))}
                </section>
              ))}
            </div>
          )}
          <div className="flex flex-col items-center justify-between gap-4 border-t border-border pt-8 sm:flex-row">
            <Link
              to={kind === "terms" ? "/privacy-policy" : "/terms-of-service"}
              className="text-sm text-muted underline underline-offset-4 transition-opacity hover:opacity-75"
            >
              {kind === "terms"
                ? t("cloud.terms.privacyPolicy", {
                    defaultValue: "Privacy Policy",
                  })
                : t("cloud.privacy.termsOfService", {
                    defaultValue: "Terms of Service",
                  })}
            </Link>
            <Link
              to="/login"
              className="text-sm text-muted transition-opacity hover:opacity-75"
            >
              {t("cloud.terms.returnToLogin", {
                defaultValue: "Return to login",
              })}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
