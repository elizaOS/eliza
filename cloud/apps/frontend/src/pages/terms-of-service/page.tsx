import { BrandCard, CornerBrackets, ElizaCloudLockup } from "@elizaos/cloud-ui";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { generatePageMetadata } from "@/lib/seo";
import type { Metadata } from "@/lib/seo/types";
import LandingHeader from "../../components/layout/landing-header";

export const metadata: Metadata = generatePageMetadata({
  title: "Terms of Service",
  description:
    "Terms of Service for AGENT CLOUD - Read our terms and conditions for using our AI agent development platform.",
  path: "/terms-of-service",
  keywords: ["terms of service", "terms and conditions", "legal", "agreement", "elizaOS"],
});

export default function TermsOfServicePage() {
  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden">
      <LandingHeader />

      <video
        src="/videos/Hero Cloud_x3 Slower_1_Scale 5.mp4"
        autoPlay
        loop
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
        style={{
          filter: "brightness(0.4) blur(2px)",
        }}
      />

      <div className="absolute inset-0 bg-gradient-to-br from-black/60 via-black/40 to-black/60" />

      <div className="relative z-10 flex flex-1 items-start justify-center p-4 py-12">
        <BrandCard className="w-full max-w-4xl backdrop-blur-sm bg-black/60">
          <CornerBrackets size="lg" className="opacity-50" />

          <div className="relative z-10 space-y-8">
            <Link
              to="/login"
              className="inline-flex items-center gap-2 text-sm text-white/60 hover:text-[#FF5800] transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to login
            </Link>

            <div className="space-y-3 pb-4 border-b border-white/10">
              <ElizaCloudLockup logoClassName="h-5" textClassName="text-[11px]" />
              <h1 className="text-4xl font-bold tracking-tight text-white">Terms of Service</h1>
              <p className="text-base text-white/60">Last updated: November 4, 2025</p>
            </div>

            <div className="prose prose-invert max-w-none space-y-8">
              <section className="space-y-4">
                <h2 className="text-2xl font-bold text-white">1. Acceptance of Terms</h2>
                <p className="text-white/80 leading-relaxed">
                  By accessing and using the elizaOS platform (&quot;Service&quot;), you accept and
                  agree to be bound by the terms and provision of this agreement. If you do not
                  agree to abide by the above, please do not use this service.
                </p>
              </section>

              <section className="space-y-4">
                <h2 className="text-2xl font-bold text-white">2. Use License</h2>
                <p className="text-white/80 leading-relaxed">
                  Permission is granted to temporarily access the materials (information or
                  software) on elizaOS for personal, non-commercial transitory viewing only. This is
                  the grant of a license, not a transfer of title, and under this license you may
                  not:
                </p>
                <ul className="list-disc list-inside space-y-2 text-white/80 ml-4">
                  <li>Modify or copy the materials</li>
                  <li>Use the materials for any commercial purpose or for any public display</li>
                  <li>Attempt to reverse engineer any software contained on elizaOS</li>
                  <li>Remove any copyright or other proprietary notations from the materials</li>
                  <li>
                    Transfer the materials to another person or &quot;mirror&quot; the materials on
                    any other server
                  </li>
                </ul>
              </section>

              <section className="space-y-4">
                <h2 className="text-2xl font-bold text-white">3. Account Terms</h2>
                <p className="text-white/80 leading-relaxed">
                  You must provide a valid email address and any other information requested in
                  order to complete the signup process. You are responsible for maintaining the
                  security of your account and password. elizaOS cannot and will not be liable for
                  any loss or damage from your failure to comply with this security obligation.
                </p>
              </section>

              <section className="space-y-4">
                <h2 className="text-2xl font-bold text-white">4. API Usage and Limits</h2>
                <p className="text-white/80 leading-relaxed">
                  Your use of the elizaOS API is subject to rate limits and usage quotas. You agree
                  not to exceed these limits or attempt to circumvent them. We reserve the right to
                  modify, suspend, or discontinue the API at any time with or without notice.
                </p>
              </section>

              <section className="space-y-4">
                <h2 className="text-2xl font-bold text-white">5. Payment and Billing</h2>
                <p className="text-white/80 leading-relaxed">
                  You agree to pay all fees associated with your use of the Service. All fees are
                  non-refundable unless otherwise stated. We reserve the right to change our pricing
                  structure at any time with reasonable notice to users.
                </p>
              </section>

              <section className="space-y-4">
                <h2 className="text-2xl font-bold text-white">6. Prohibited Uses</h2>
                <p className="text-white/80 leading-relaxed">
                  You may not use the Service for any illegal or unauthorized purpose. You must not,
                  in the use of the Service, violate any laws in your jurisdiction including but not
                  limited to copyright laws.
                </p>
              </section>

              <section className="space-y-4">
                <h2 className="text-2xl font-bold text-white">7. Disclaimer</h2>
                <p className="text-white/80 leading-relaxed">
                  The materials on elizaOS are provided on an &apos;as is&apos; basis. elizaOS makes
                  no warranties, expressed or implied, and hereby disclaims and negates all other
                  warranties including, without limitation, implied warranties or conditions of
                  merchantability, fitness for a particular purpose, or non-infringement of
                  intellectual property or other violation of rights.
                </p>
              </section>

              <section className="space-y-4">
                <h2 className="text-2xl font-bold text-white">8. Limitations</h2>
                <p className="text-white/80 leading-relaxed">
                  In no event shall elizaOS or its suppliers be liable for any damages (including,
                  without limitation, damages for loss of data or profit, or due to business
                  interruption) arising out of the use or inability to use the materials on elizaOS,
                  even if elizaOS or an authorized representative has been notified orally or in
                  writing of the possibility of such damage.
                </p>
              </section>

              <section className="space-y-4">
                <h2 className="text-2xl font-bold text-white">9. Modifications</h2>
                <p className="text-white/80 leading-relaxed">
                  elizaOS may revise these terms of service at any time without notice. By using
                  this Service you are agreeing to be bound by the then current version of these
                  terms of service.
                </p>
              </section>

              <section className="space-y-4">
                <h2 className="text-2xl font-bold text-white">10. Contact Information</h2>
                <p className="text-white/80 leading-relaxed">
                  If you have any questions about these Terms, please contact us through our support
                  channels.
                </p>
              </section>
            </div>

            <div className="pt-8 border-t border-white/10 flex flex-col sm:flex-row gap-4 justify-between items-center">
              <Link
                to="/privacy-policy"
                className="text-sm text-white/60 hover:text-[#FF5800] transition-colors underline underline-offset-4"
              >
                Privacy Policy
              </Link>
              <Link
                to="/login"
                className="text-sm text-white/60 hover:text-[#FF5800] transition-colors"
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
