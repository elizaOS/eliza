/**
 * Privacy Policy (public, static).  Marketing
 * `LandingHeader` / `Footer` chrome dropped (stays on `eliza.app`).
 */

import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

type TFn = ReturnType<typeof useCloudT>;

function buildSections(t: TFn): Array<{ title: string; body: string }> {
  return [
    {
      title: t("cloud.privacy.s1Title", { defaultValue: "1. Introduction" }),
      body: t("cloud.privacy.s1Body", {
        defaultValue:
          "Eliza Cloud is committed to protecting your personal information and your right to privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard information when you use the service.",
      }),
    },
    {
      title: t("cloud.privacy.s2Title", {
        defaultValue: "2. Information We Collect",
      }),
      body: t("cloud.privacy.s2Body", {
        defaultValue:
          "We collect information you provide directly, including account details, support requests, billing details, API usage, and information you choose to submit through Eliza Cloud features.",
      }),
    },
    {
      title: t("cloud.privacy.s3Title", {
        defaultValue: "3. Automatically Collected Information",
      }),
      body: t("cloud.privacy.s3Body", {
        defaultValue:
          "When you access the service, we may collect device identifiers, browser details, operating system, access times, viewed pages, feature usage, API usage patterns, and performance metrics.",
      }),
    },
    {
      title: t("cloud.privacy.s4Title", {
        defaultValue: "4. How We Use Your Information",
      }),
      body: t("cloud.privacy.s4Body", {
        defaultValue:
          "We use collected information to provide and improve the service, process transactions, send technical notices, respond to support requests, analyze usage, prevent abuse, and comply with legal obligations.",
      }),
    },
    {
      title: t("cloud.privacy.s5Title", {
        defaultValue: "5. Information Sharing and Disclosure",
      }),
      body: t("cloud.privacy.s5Body", {
        defaultValue:
          "We may share information with service providers, when required by law, to protect users and the service, in connection with a business transaction, or with your consent. We do not sell personal information to third parties.",
      }),
    },
    {
      title: t("cloud.privacy.s6Title", { defaultValue: "6. Data Security" }),
      body: t("cloud.privacy.s6Body", {
        defaultValue:
          "We use technical and organizational measures to protect personal information, but no internet transmission or storage system can be guaranteed to be completely secure.",
      }),
    },
    {
      title: t("cloud.privacy.s7Title", { defaultValue: "7. Data Retention" }),
      body: t("cloud.privacy.s7Body", {
        defaultValue:
          "We retain personal information for as long as needed for the purposes described in this policy unless a longer retention period is required or permitted by law.",
      }),
    },
    {
      title: t("cloud.privacy.s8Title", {
        defaultValue: "8. Your Rights and Choices",
      }),
      body: t("cloud.privacy.s8Body", {
        defaultValue:
          "Depending on your location, you may have rights to access, correct, delete, object to processing, request portability, or withdraw consent for certain personal information.",
      }),
    },
    {
      title: t("cloud.privacy.s9Title", {
        defaultValue: "9. Cookies and Tracking Technologies",
      }),
      body: t("cloud.privacy.s9Body", {
        defaultValue:
          "We use cookies and similar technologies to understand service usage and support product functionality. Browser settings may allow you to control cookies.",
      }),
    },
    {
      title: t("cloud.privacy.s10Title", {
        defaultValue: "10. Third-Party Services",
      }),
      body: t("cloud.privacy.s10Body", {
        defaultValue:
          "The service may link to third-party websites or services. We are not responsible for their privacy practices and encourage reviewing their policies.",
      }),
    },
    {
      title: t("cloud.privacy.s11Title", {
        defaultValue: "11. Changes to This Policy",
      }),
      body: t("cloud.privacy.s11Body", {
        defaultValue:
          "We may update this Privacy Policy from time to time. Continued use of the service after updates means you accept the updated policy.",
      }),
    },
    {
      title: t("cloud.privacy.s12Title", { defaultValue: "12. Contact Us" }),
      body: t("cloud.privacy.s12Body", {
        defaultValue:
          "Questions about this Privacy Policy or our privacy practices can be sent through Eliza Cloud support channels.",
      }),
    },
  ];
}

export default function PrivacyPolicyPage() {
  const t = useCloudT();
  usePageTitle(
    t("cloud.privacy.metaTitle", {
      defaultValue: "Privacy Policy | Eliza Cloud",
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
            {t("cloud.privacy.backToLogin", { defaultValue: "Back to login" })}
          </Link>

          <div className="space-y-3 border-b border-white/14 pb-6">
            <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
              {t("cloud.privacy.heading", { defaultValue: "Privacy Policy" })}
            </h1>
            <p className="text-base text-white/74">
              {t("cloud.privacy.lastUpdated", {
                defaultValue: "Last updated: November 4, 2025",
              })}
            </p>
          </div>

          <div className="space-y-10">
            {sections.map((section) => (
              <section key={section.title} className="space-y-3">
                <h2 className="text-2xl font-bold text-white">
                  {section.title}
                </h2>
                <p className="leading-relaxed text-white/80">{section.body}</p>
              </section>
            ))}
          </div>

          <div className="flex flex-col items-center justify-between gap-4 border-t border-white/14 pt-8 sm:flex-row">
            <Link
              to="/terms-of-service"
              className="text-sm text-white/60 underline underline-offset-4 transition-opacity hover:opacity-75"
            >
              {t("cloud.privacy.termsOfService", {
                defaultValue: "Terms of Service",
              })}
            </Link>
            <Link
              to="/login"
              className="text-sm text-white/60 transition-opacity hover:opacity-75"
            >
              {t("cloud.privacy.returnToLogin", {
                defaultValue: "Return to login",
              })}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
