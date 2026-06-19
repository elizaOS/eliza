/**
 * Terms of Service (public, static). Ported from
 * `@elizaos/cloud-frontend/src/pages/terms-of-service/page.tsx`.
 *
 * Change vs source: the cloud-frontend marketing `LandingHeader` / `Footer`
 * chrome is dropped (that landing subsystem stays on `eliza.app` and is not part
 * of this domain). A simple back-link header replaces it.
 */

import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

type TFn = ReturnType<typeof useCloudT>;

function buildSections(
  t: TFn,
): Array<{ title: string; body: React.ReactNode }> {
  return [
    {
      title: t("cloud.terms.s1Title", {
        defaultValue: "1. Acceptance of Terms",
      }),
      body: (
        <p className="leading-relaxed text-white/80">
          {t("cloud.terms.s1Body", {
            defaultValue:
              'By accessing and using the elizaOS platform ("Service"), you accept and agree to be bound by the terms and provision of this agreement. If you do not agree to abide by the above, please do not use this service.',
          })}
        </p>
      ),
    },
    {
      title: t("cloud.terms.s2Title", { defaultValue: "2. Use License" }),
      body: (
        <>
          <p className="leading-relaxed text-white/80">
            {t("cloud.terms.s2Body", {
              defaultValue:
                "Permission is granted to temporarily access the materials (information or software) on elizaOS for personal, non-commercial transitory viewing only. This is the grant of a license, not a transfer of title, and under this license you may not:",
            })}
          </p>
          <ul className="ml-4 list-inside list-disc space-y-2 text-white/80">
            <li>
              {t("cloud.terms.s2Item1", {
                defaultValue: "Modify or copy the materials",
              })}
            </li>
            <li>
              {t("cloud.terms.s2Item2", {
                defaultValue:
                  "Use the materials for any commercial purpose or for any public display",
              })}
            </li>
            <li>
              {t("cloud.terms.s2Item3", {
                defaultValue:
                  "Attempt to reverse engineer any software contained on elizaOS",
              })}
            </li>
            <li>
              {t("cloud.terms.s2Item4", {
                defaultValue:
                  "Remove any copyright or other proprietary notations from the materials",
              })}
            </li>
            <li>
              {t("cloud.terms.s2Item5", {
                defaultValue:
                  'Transfer the materials to another person or "mirror" the materials on any other server',
              })}
            </li>
          </ul>
        </>
      ),
    },
    {
      title: t("cloud.terms.s3Title", { defaultValue: "3. Account Terms" }),
      body: (
        <p className="leading-relaxed text-white/80">
          {t("cloud.terms.s3Body", {
            defaultValue:
              "You must provide a valid email address and any other information requested in order to complete the signup process. You are responsible for maintaining the security of your account and password. elizaOS cannot and will not be liable for any loss or damage from your failure to comply with this security obligation.",
          })}
        </p>
      ),
    },
    {
      title: t("cloud.terms.s4Title", {
        defaultValue: "4. API Usage and Limits",
      }),
      body: (
        <p className="leading-relaxed text-white/80">
          {t("cloud.terms.s4Body", {
            defaultValue:
              "Your use of the elizaOS API is subject to rate limits and usage quotas. You agree not to exceed these limits or attempt to circumvent them. We reserve the right to modify, suspend, or discontinue the API at any time with or without notice.",
          })}
        </p>
      ),
    },
    {
      title: t("cloud.terms.s5Title", {
        defaultValue: "5. Payment and Billing",
      }),
      body: (
        <p className="leading-relaxed text-white/80">
          {t("cloud.terms.s5Body", {
            defaultValue:
              "You agree to pay all fees associated with your use of the Service. All fees are non-refundable unless otherwise stated. We reserve the right to change our pricing structure at any time with reasonable notice to users.",
          })}
        </p>
      ),
    },
    {
      title: t("cloud.terms.s6Title", { defaultValue: "6. Prohibited Uses" }),
      body: (
        <p className="leading-relaxed text-white/80">
          {t("cloud.terms.s6Body", {
            defaultValue:
              "You may not use the Service for any illegal or unauthorized purpose. You must not, in the use of the Service, violate any laws in your jurisdiction including but not limited to copyright laws.",
          })}
        </p>
      ),
    },
    {
      title: t("cloud.terms.s7Title", { defaultValue: "7. Disclaimer" }),
      body: (
        <p className="leading-relaxed text-white/80">
          {t("cloud.terms.s7Body", {
            defaultValue:
              "The materials on elizaOS are provided on an 'as is' basis. elizaOS makes no warranties, expressed or implied, and hereby disclaims and negates all other warranties including, without limitation, implied warranties or conditions of merchantability, fitness for a particular purpose, or non-infringement of intellectual property or other violation of rights.",
          })}
        </p>
      ),
    },
    {
      title: t("cloud.terms.s8Title", { defaultValue: "8. Limitations" }),
      body: (
        <p className="leading-relaxed text-white/80">
          {t("cloud.terms.s8Body", {
            defaultValue:
              "In no event shall elizaOS or its suppliers be liable for any damages (including, without limitation, damages for loss of data or profit, or due to business interruption) arising out of the use or inability to use the materials on elizaOS, even if elizaOS or an authorized representative has been notified orally or in writing of the possibility of such damage.",
          })}
        </p>
      ),
    },
    {
      title: t("cloud.terms.s9Title", { defaultValue: "9. Modifications" }),
      body: (
        <p className="leading-relaxed text-white/80">
          {t("cloud.terms.s9Body", {
            defaultValue:
              "elizaOS may revise these terms of service at any time without notice. By using this Service you are agreeing to be bound by the then current version of these terms of service.",
          })}
        </p>
      ),
    },
    {
      title: t("cloud.terms.s10Title", {
        defaultValue: "10. Contact Information",
      }),
      body: (
        <p className="leading-relaxed text-white/80">
          {t("cloud.terms.s10Body", {
            defaultValue:
              "If you have any questions about these Terms, please contact us through our support channels.",
          })}
        </p>
      ),
    },
  ];
}

export default function TermsOfServicePage() {
  const t = useCloudT();
  usePageTitle(
    t("cloud.terms.metaTitle", {
      defaultValue: "Terms of Service | Eliza Cloud",
    }),
  );
  const sections = buildSections(t);
  return (
    <div className="theme-cloud flex min-h-screen w-full flex-col bg-black font-poppins text-white">
      <main id="main" className="flex-1 px-6 pt-16 pb-16 sm:px-8 lg:px-12">
        <div className="mx-auto w-full max-w-4xl space-y-10">
          <Link
            to="/login"
            className="inline-flex items-center gap-2 text-sm text-white/60 transition-opacity hover:opacity-75"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("cloud.terms.backToLogin", { defaultValue: "Back to login" })}
          </Link>

          <div className="space-y-3 border-b border-white/14 pb-6">
            <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
              {t("cloud.terms.heading", { defaultValue: "Terms of Service" })}
            </h1>
            <p className="text-base text-white/74">
              {t("cloud.terms.lastUpdated", {
                defaultValue: "Last updated: November 4, 2025",
              })}
            </p>
          </div>

          <div className="prose prose-invert max-w-none space-y-10">
            {sections.map((section) => (
              <section key={section.title} className="space-y-3">
                <h2 className="text-2xl font-bold text-white">
                  {section.title}
                </h2>
                {section.body}
              </section>
            ))}
          </div>

          <div className="flex flex-col items-center justify-between gap-4 border-t border-white/14 pt-8 sm:flex-row">
            <Link
              to="/privacy-policy"
              className="text-sm text-white/60 underline underline-offset-4 transition-opacity hover:opacity-75"
            >
              {t("cloud.terms.privacyPolicy", {
                defaultValue: "Privacy Policy",
              })}
            </Link>
            <Link
              to="/login"
              className="text-sm text-white/60 transition-opacity hover:opacity-75"
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
