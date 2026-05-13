import { BrandCard, CornerBrackets, ElizaCloudLockup } from "@elizaos/cloud-ui";
import { ArrowLeft } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import LandingHeader from "../../components/layout/landing-header";

const sections = [
  {
    title: "1. Introduction",
    body: "Eliza Cloud is committed to protecting your personal information and your right to privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard information when you use the service.",
  },
  {
    title: "2. Information We Collect",
    body: "We collect information you provide directly, including account details, support requests, billing details, API usage, and information you choose to submit through Eliza Cloud features.",
  },
  {
    title: "3. Automatically Collected Information",
    body: "When you access the service, we may collect device identifiers, browser details, operating system, access times, viewed pages, feature usage, API usage patterns, and performance metrics.",
  },
  {
    title: "4. How We Use Your Information",
    body: "We use collected information to provide and improve the service, process transactions, send technical notices, respond to support requests, analyze usage, prevent abuse, and comply with legal obligations.",
  },
  {
    title: "5. Information Sharing and Disclosure",
    body: "We may share information with service providers, when required by law, to protect users and the service, in connection with a business transaction, or with your consent. We do not sell personal information to third parties.",
  },
  {
    title: "6. Data Security",
    body: "We use technical and organizational measures to protect personal information, but no internet transmission or storage system can be guaranteed to be completely secure.",
  },
  {
    title: "7. Data Retention",
    body: "We retain personal information for as long as needed for the purposes described in this policy unless a longer retention period is required or permitted by law.",
  },
  {
    title: "8. Your Rights and Choices",
    body: "Depending on your location, you may have rights to access, correct, delete, object to processing, request portability, or withdraw consent for certain personal information.",
  },
  {
    title: "9. Cookies and Tracking Technologies",
    body: "We use cookies and similar technologies to understand service usage and support product functionality. Browser settings may allow you to control cookies.",
  },
  {
    title: "10. Third-Party Services",
    body: "The service may link to third-party websites or services. We are not responsible for their privacy practices and encourage reviewing their policies.",
  },
  {
    title: "11. Changes to This Policy",
    body: "We may update this Privacy Policy from time to time. Continued use of the service after updates means you accept the updated policy.",
  },
  {
    title: "12. Contact Us",
    body: "Questions about this Privacy Policy or our privacy practices can be sent through Eliza Cloud support channels.",
  },
];

export default function PrivacyPolicyPage() {
  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-black">
      <Helmet>
        <title>Privacy Policy | Eliza Cloud</title>
        <meta
          name="description"
          content="Privacy Policy for Eliza Cloud, including how information is collected, used, retained, and protected."
        />
      </Helmet>

      <LandingHeader />

      <div className="absolute inset-0 bg-gradient-to-br from-black/60 via-black/40 to-black/60" />

      <div className="relative z-10 flex flex-1 items-start justify-center p-4 py-12">
        <BrandCard className="w-full max-w-4xl bg-black/60 backdrop-blur-sm">
          <CornerBrackets size="lg" className="opacity-50" />

          <div className="relative z-10 space-y-8">
            <Link
              to="/login"
              className="inline-flex items-center gap-2 text-sm text-white/60 transition-colors hover:text-[#FF5800]"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to login
            </Link>

            <div className="space-y-3 border-b border-white/10 pb-4">
              <ElizaCloudLockup logoClassName="h-5" textClassName="text-[11px]" />
              <h1 className="text-4xl font-bold tracking-tight text-white">Privacy Policy</h1>
              <p className="text-base text-white/60">Last updated: November 4, 2025</p>
            </div>

            <div className="space-y-8">
              {sections.map((section) => (
                <section key={section.title} className="space-y-4">
                  <h2 className="text-2xl font-bold text-white">{section.title}</h2>
                  <p className="text-white/80 leading-relaxed">{section.body}</p>
                </section>
              ))}
            </div>

            <div className="flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 sm:flex-row">
              <Link
                to="/terms-of-service"
                className="text-sm text-white/60 underline underline-offset-4 transition-colors hover:text-[#FF5800]"
              >
                Terms of Service
              </Link>
              <Link
                to="/login"
                className="text-sm text-white/60 transition-colors hover:text-[#FF5800]"
              >
                Return to login
              </Link>
            </div>
          </div>
        </BrandCard>
      </div>
    </div>
  );
}
