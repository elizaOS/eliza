import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import "nextra-theme-docs/style.css";
import "./docs.css";
import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { LlmsTxtBadge } from "@/components/docs/llms-txt-badge";

export const metadata: Metadata = {
  title: {
    default: "elizaOS Cloud Documentation",
    template: "%s | elizaOS Cloud",
  },
  description:
    "Documentation for elizaOS Cloud - The AI Agent Development Platform.",
  keywords: ["elizaOS", "AI agents", "cloud platform", "documentation", "API"],
  openGraph: {
    title: "elizaOS Cloud Documentation",
    description:
      "Documentation for elizaOS Cloud - The AI Agent Development Platform.",
    siteName: "elizaOS Platform",
    type: "website",
    images: [
      {
        url: "/cloudlogo.png",
        width: 1200,
        height: 630,
        alt: "elizaOS Cloud - Make Agents in Seconds",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "elizaOS Cloud Documentation",
    description:
      "Documentation for elizaOS Cloud - The AI Agent Development Platform.",
    images: ["/cloudlogo.png"],
    creator: "@elizaos",
    site: "@elizaos",
  },
};

const navbar = (
  <Navbar
    logo={
      <div className="flex items-center gap-3 pointer-events-none select-none">
        <Image
          src="/cloudlogo-white.svg"
          alt="Cloud"
          width={90}
          height={35}
          priority
          draggable={false}
        />
        <span className="text-white/30 text-xs font-medium px-1.5 py-0.5 border border-white/10 bg-white/5">
          DOCS
        </span>
      </div>
    }
    projectLink="https://github.com/elizaOS/eliza"
  >
    <LlmsTxtBadge />
    <Link
      href="/dashboard"
      className="flex items-center gap-1.5 text-xs font-medium text-white/70 hover:text-white transition-all duration-200 px-3 py-1.5 rounded border border-white/10 hover:border-white/20 hover:bg-white/5"
    >
      Dashboard →
    </Link>
  </Navbar>
);

const footer = (
  <Footer>
    <div className="w-full relative">
      {/* Gradient Mesh Background */}
      <div
        className="absolute inset-0 pointer-events-none overflow-hidden"
        style={{
          background: `
            radial-gradient(ellipse 80% 50% at 20% 120%, rgba(255, 88, 0, 0.08) 0%, transparent 50%),
            radial-gradient(ellipse 60% 40% at 80% 100%, rgba(11, 53, 241, 0.06) 0%, transparent 50%),
            radial-gradient(ellipse 40% 30% at 50% 110%, rgba(255, 88, 0, 0.04) 0%, transparent 50%)
          `,
        }}
      />

      {/* Tech Grid Pattern Overlay */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.02]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
          maskImage:
            "linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)",
        }}
      />

      <div className="relative z-10">
        {/* Main Footer Content */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-10 lg:gap-8 mb-12">
          {/* Brand Column - Larger */}
          <div className="lg:col-span-2">
            <div className="flex items-center gap-2.5 mb-5">
              {/* Animated Logo Mark */}
              <div className="relative">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff5800] to-[#ff7a33] flex items-center justify-center">
                  <svg
                    className="w-4 h-4 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                  </svg>
                </div>
                <div className="absolute inset-0 rounded-lg bg-[#ff5800] blur-lg opacity-30" />
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-white font-bold text-lg tracking-tight">
                  Eliza
                </span>
                <span className="text-[#ff5800] font-bold text-lg tracking-tight">
                  Cloud
                </span>
              </div>
            </div>
            <p className="text-white/50 text-sm leading-relaxed max-w-[300px] mb-6">
              The complete platform for building, deploying, and scaling
              intelligent AI agents. Trusted by developers worldwide.
            </p>

            {/* API Status Indicator */}
            <div className="inline-flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] hover:border-white/10 transition-colors group">
              <div className="relative">
                <div className="w-2 h-2 rounded-full bg-emerald-400" />
                <div className="absolute inset-0 w-2 h-2 rounded-full bg-emerald-400 animate-ping opacity-75" />
              </div>
              <span className="text-white/60 text-xs font-medium group-hover:text-white/80 transition-colors">
                All Systems Operational
              </span>
              <svg
                className="w-3 h-3 text-white/30 group-hover:text-white/50 transition-colors"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </div>
          </div>

          {/* Documentation Column */}
          <div>
            <h4 className="text-[#ff5800]/80 text-[10px] font-bold uppercase tracking-[0.2em] mb-5 flex items-center gap-2">
              <span className="w-3 h-px bg-[#ff5800]/50" />
              Documentation
            </h4>
            <nav className="flex flex-col gap-3">
              <Link
                href="/docs/quickstart"
                className="text-white/60 text-sm hover:text-[#ff5800] hover:translate-x-1 transition-all duration-200 flex items-center gap-2 group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white/20 group-hover:bg-[#ff5800] group-hover:shadow-[0_0_8px_rgba(255,88,0,0.5)] transition-all" />
                Quickstart
              </Link>
              <Link
                href="/docs/api"
                className="text-white/60 text-sm hover:text-[#ff5800] hover:translate-x-1 transition-all duration-200 flex items-center gap-2 group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white/20 group-hover:bg-[#ff5800] group-hover:shadow-[0_0_8px_rgba(255,88,0,0.5)] transition-all" />
                API Reference
              </Link>
              <Link
                href="/docs/agents"
                className="text-white/60 text-sm hover:text-[#ff5800] hover:translate-x-1 transition-all duration-200 flex items-center gap-2 group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white/20 group-hover:bg-[#ff5800] group-hover:shadow-[0_0_8px_rgba(255,88,0,0.5)] transition-all" />
                AI Agents
              </Link>
              <Link
                href="/docs/sdks"
                className="text-white/60 text-sm hover:text-[#ff5800] hover:translate-x-1 transition-all duration-200 flex items-center gap-2 group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white/20 group-hover:bg-[#ff5800] group-hover:shadow-[0_0_8px_rgba(255,88,0,0.5)] transition-all" />
                SDKs
              </Link>
            </nav>
          </div>

          {/* Platform Column */}
          <div>
            <h4 className="text-[#ff5800]/80 text-[10px] font-bold uppercase tracking-[0.2em] mb-5 flex items-center gap-2">
              <span className="w-3 h-px bg-[#ff5800]/50" />
              Platform
            </h4>
            <nav className="flex flex-col gap-3">
              <Link
                href="/dashboard"
                className="text-white/60 text-sm hover:text-[#ff5800] hover:translate-x-1 transition-all duration-200 flex items-center gap-2 group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white/20 group-hover:bg-[#ff5800] group-hover:shadow-[0_0_8px_rgba(255,88,0,0.5)] transition-all" />
                Dashboard
              </Link>
              <Link
                href="/docs/billing"
                className="text-white/60 text-sm hover:text-[#ff5800] hover:translate-x-1 transition-all duration-200 flex items-center gap-2 group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white/20 group-hover:bg-[#ff5800] group-hover:shadow-[0_0_8px_rgba(255,88,0,0.5)] transition-all" />
                Pricing
              </Link>
              <Link
                href="/docs/changelog"
                className="text-white/60 text-sm hover:text-[#ff5800] hover:translate-x-1 transition-all duration-200 flex items-center gap-2 group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white/20 group-hover:bg-[#ff5800] group-hover:shadow-[0_0_8px_rgba(255,88,0,0.5)] transition-all" />
                Changelog
              </Link>
              <a
                href="https://status.eliza.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/60 text-sm hover:text-[#ff5800] hover:translate-x-1 transition-all duration-200 flex items-center gap-2 group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white/20 group-hover:bg-[#ff5800] group-hover:shadow-[0_0_8px_rgba(255,88,0,0.5)] transition-all" />
                Status
              </a>
            </nav>
          </div>

          {/* Company Column */}
          <div>
            <h4 className="text-[#ff5800]/80 text-[10px] font-bold uppercase tracking-[0.2em] mb-5 flex items-center gap-2">
              <span className="w-3 h-px bg-[#ff5800]/50" />
              Company
            </h4>
            <nav className="flex flex-col gap-3">
              <a
                href="https://elizaos.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/60 text-sm hover:text-[#ff5800] hover:translate-x-1 transition-all duration-200 flex items-center gap-2 group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white/20 group-hover:bg-[#ff5800] group-hover:shadow-[0_0_8px_rgba(255,88,0,0.5)] transition-all" />
                About
              </a>
              <Link
                href="/terms-of-service"
                className="text-white/60 text-sm hover:text-[#ff5800] hover:translate-x-1 transition-all duration-200 flex items-center gap-2 group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white/20 group-hover:bg-[#ff5800] group-hover:shadow-[0_0_8px_rgba(255,88,0,0.5)] transition-all" />
                Terms
              </Link>
              <Link
                href="/privacy-policy"
                className="text-white/60 text-sm hover:text-[#ff5800] hover:translate-x-1 transition-all duration-200 flex items-center gap-2 group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white/20 group-hover:bg-[#ff5800] group-hover:shadow-[0_0_8px_rgba(255,88,0,0.5)] transition-all" />
                Privacy
              </Link>
              <a
                href="mailto:support@eliza.ai"
                className="text-white/60 text-sm hover:text-[#ff5800] hover:translate-x-1 transition-all duration-200 flex items-center gap-2 group"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white/20 group-hover:bg-[#ff5800] group-hover:shadow-[0_0_8px_rgba(255,88,0,0.5)] transition-all" />
                Contact
              </a>
            </nav>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-5 pt-8 border-t border-white/[0.06]">
          <div className="flex flex-wrap items-center justify-center md:justify-start gap-x-4 gap-y-2 text-white/25 text-xs font-mono">
            <span className="flex items-center gap-1.5">
              <svg
                className="w-3 h-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                />
              </svg>
              MIT {new Date().getFullYear()}
            </span>
            <span className="text-white/10">|</span>
            <span>© elizaOS</span>
            <span className="text-white/10">|</span>
            <span className="text-white/40 hidden md:inline">
              Built for developers who ship
            </span>
          </div>

          {/* Social Links - Enhanced */}
          <div className="flex items-center gap-1">
            <a
              href="https://github.com/elizaOS/eliza"
              target="_blank"
              rel="noopener noreferrer"
              className="p-2.5 rounded-lg text-white/30 hover:text-white hover:bg-white/[0.05] transition-all duration-200"
              aria-label="GitHub"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
            </a>
            <a
              href="https://discord.gg/7Rmq6NPR"
              target="_blank"
              rel="noopener noreferrer"
              className="p-2.5 rounded-lg text-white/30 hover:text-[#5865F2] hover:bg-[#5865F2]/10 transition-all duration-200"
              aria-label="Discord"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
            </a>
            <a
              href="https://x.com/elizaos"
              target="_blank"
              rel="noopener noreferrer"
              className="p-2.5 rounded-lg text-white/30 hover:text-white hover:bg-white/[0.05] transition-all duration-200"
              aria-label="X (Twitter)"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
          </div>
        </div>
      </div>
    </div>
  </Footer>
);

export default async function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pageMap = await getPageMap("/docs");

  return (
    <html lang="en" dir="ltr" suppressHydrationWarning className="dark">
      <Head>
        <meta name="theme-color" content="#0a0a0a" />
        <link rel="icon" href="/favicon.ico" />
        {/* Critical CSS variable needed before JS loads to prevent IntersectionObserver error */}
        <style
          dangerouslySetInnerHTML={{
            __html: ":root, body { --nextra-navbar-height: 64px; }",
          }}
        />
      </Head>
      <body
        className="bg-[#0a0a0a] antialiased"
        style={{ ["--nextra-navbar-height" as any]: "64px" }}
      >
        <Layout
          navbar={navbar}
          pageMap={pageMap}
          docsRepositoryBase="https://github.com/elizaOS/eliza/tree/main/docs"
          footer={footer}
          sidebar={{
            defaultMenuCollapseLevel: 1,
            toggleButton: true,
          }}
          editLink="Edit this page"
          feedback={{ content: "Question? Give us feedback →" }}
          navigation={true}
          darkMode={true}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
