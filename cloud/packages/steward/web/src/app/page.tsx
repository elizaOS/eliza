"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import Image from "next/image";
import { useRef } from "react";
import { CodeBlock } from "@/components/code-block";
import { Reveal, StaggerContainer, StaggerItem } from "@/components/motion-wrapper";
import { Nav } from "@/components/nav";

const easeOutExpo: [number, number, number, number] = [0.16, 1, 0.3, 1];

// --- Hero Section ---
function Hero() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"],
  });
  const opacity = useTransform(scrollYProgress, [0, 0.5], [1, 0]);
  const y = useTransform(scrollYProgress, [0, 0.5], [0, 80]);

  return (
    <section ref={ref} className="relative h-screen flex items-center px-6 md:px-10 pt-16">
      {/* Grid lines background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-[20%] w-px h-full bg-border-subtle opacity-40" />
        <div className="absolute top-0 left-[40%] w-px h-full bg-border-subtle opacity-20" />
        <div className="absolute top-0 left-[70%] w-px h-full bg-border-subtle opacity-30" />
        <div className="absolute top-[30%] left-0 w-full h-px bg-border-subtle opacity-20" />
        <div className="absolute top-[60%] left-0 w-full h-px bg-border-subtle opacity-15" />
      </div>

      {/* Compass star watermark */}
      <div className="absolute top-1/2 right-[5%] -translate-y-1/2 opacity-[0.03] pointer-events-none hidden lg:block">
        <Image src="/logo.png" alt="" width={600} height={600} className="w-[500px] h-[500px]" />
      </div>

      <motion.div style={{ opacity, y }} className="relative max-w-[1400px] mx-auto w-full">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
          {/* Left: headline */}
          <div className="lg:col-span-7">
            <motion.p
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, ease: easeOutExpo, delay: 0.1 }}
              className="text-sm text-text-tertiary tracking-widest uppercase mb-6"
            >
              Governance infrastructure for AI agents
            </motion.p>

            <motion.h1
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: easeOutExpo, delay: 0.2 }}
              className="font-display text-hero-landing font-800 leading-[0.92] tracking-[-0.03em]"
            >
              Agents don&apos;t need keys.
              <br />
              <span className="text-[oklch(0.75_0.15_55)]">They need permission.</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: easeOutExpo, delay: 0.4 }}
              className="mt-8 text-lg text-text-secondary max-w-lg leading-relaxed"
            >
              Every credential encrypted. Every call proxied. Every dollar tracked. Open-source
              middleware that sits between your agents and everything they touch.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: easeOutExpo, delay: 0.55 }}
              className="mt-10 flex items-center gap-5"
            >
              <a
                href="/dashboard"
                className="px-6 py-3 bg-accent text-bg font-medium text-sm hover:bg-accent-hover transition-colors"
              >
                Launch Dashboard
              </a>
              <a
                href="https://github.com/Steward-Fi/steward"
                target="_blank"
                rel="noopener noreferrer"
                className="px-6 py-3 border border-border text-text-secondary text-sm hover:text-text hover:border-text-tertiary transition-colors"
              >
                View Source
              </a>
            </motion.div>
          </div>

          {/* Right: compact code preview */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.7, ease: easeOutExpo, delay: 0.5 }}
            className="lg:col-span-5 hidden lg:block"
          >
            <div className="border border-border bg-bg-elevated">
              <CodeBlock
                filename="agent.ts"
                language="typescript"
                typeEffect
                code={`import { StewardClient } from "@stwd/sdk"

const agent = new StewardClient({
  proxy: process.env.STEWARD_PROXY_URL,
  token: process.env.STEWARD_AGENT_TOKEN,
})

// Sign a swap — no private key in memory
await agent.sign({
  to: "0x1inch...",
  value: parseEther("0.5"),
  data: swapCalldata,
})

// Call OpenAI — no API key in env
const res = await agent.proxy("openai", {
  path: "/v1/chat/completions",
  body: { model: "gpt-4o", messages },
})`}
              />
            </div>
          </motion.div>
        </div>
      </motion.div>
    </section>
  );
}

// --- Problem Statement ---
function ProblemSection() {
  const problems = [
    {
      num: "01",
      title: "Keys live in env vars",
      desc: "Private keys and API credentials as plaintext environment variables. One prompt injection away from total compromise.",
    },
    {
      num: "02",
      title: "No boundaries",
      desc: "No spending limits, no rate limits, no approved address lists. Agents sign whatever they want, call whatever they want.",
    },
    {
      num: "03",
      title: "No visibility",
      desc: "No audit trail. No cost attribution. When something goes wrong, you find out from your bank statement.",
    },
  ];

  return (
    <section className="relative px-6 md:px-10 py-32 md:py-40">
      <div className="max-w-[1400px] mx-auto">
        <Reveal direction="up" delay={0}>
          <p className="text-sm text-text-tertiary tracking-widest uppercase mb-8">The problem</p>
        </Reveal>
        <Reveal direction="up" delay={0.1}>
          <h2 className="font-display text-hero-sm font-800 tracking-tight leading-[1.05] max-w-3xl">
            Your agent has the same access as you.
            <br />
            <span className="text-[oklch(0.75_0.15_55)]">That&apos;s the problem.</span>
          </h2>
        </Reveal>

        <StaggerContainer
          staggerDelay={0.12}
          className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border-subtle mt-16"
        >
          {problems.map((problem) => (
            <StaggerItem key={problem.title}>
              <div className="bg-bg p-8 md:p-10 h-full">
                <span className="font-display text-4xl font-800 text-border tracking-tight">
                  {problem.num}
                </span>
                <h3 className="font-display text-xl font-700 mt-5 mb-3">{problem.title}</h3>
                <p className="text-sm text-text-secondary leading-relaxed">{problem.desc}</p>
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  );
}

// --- Architecture (merged How It Works + Controls) ---
function ArchitectureSection() {
  const layers = [
    {
      num: "01",
      label: "Vault",
      detail: "AES-256-GCM encryption at rest",
      items: [
        "Wallet private keys encrypted, never exposed to agents",
        "API credentials stored and injected at the proxy layer",
        "Scoped tokens for agent authentication",
      ],
    },
    {
      num: "02",
      label: "Policy Engine",
      detail: "Default deny, explicit allow",
      items: [
        "Per-agent spending limits — daily, monthly, per-transaction",
        "Rate limiting with sliding windows per API, per agent",
        "Approved address and contract allowlists",
      ],
    },
    {
      num: "03",
      label: "Proxy Gateway",
      detail: "The only door out",
      items: [
        "Every outbound call flows through Steward",
        "Credentials injected at the edge, stripped from logs",
        "Full cost attribution and audit trail per agent",
      ],
    },
  ];

  return (
    <section className="relative px-6 md:px-10 py-32 md:py-40 border-t border-border-subtle">
      <div className="max-w-[1400px] mx-auto">
        <Reveal>
          <p className="text-sm text-text-tertiary tracking-widest uppercase mb-8">Architecture</p>
        </Reveal>
        <Reveal delay={0.1}>
          <h2 className="font-display text-hero-sm font-800 tracking-tight leading-[1.05] max-w-3xl">
            Three layers between your agent
            <br />
            <span className="text-[oklch(0.75_0.15_55)]">and the real world.</span>
          </h2>
        </Reveal>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border-subtle mt-16">
          {layers.map((layer, i) => (
            <Reveal key={layer.num} delay={i * 0.1} className="bg-bg p-8 md:p-10">
              <span className="font-display text-5xl font-800 text-border tracking-tight">
                {layer.num}
              </span>
              <h3 className="font-display text-xl font-700 mt-6 mb-1">{layer.label}</h3>
              <p className="text-xs text-text-tertiary tracking-wide uppercase mb-5">
                {layer.detail}
              </p>
              <ul className="space-y-3">
                {layer.items.map((item) => (
                  <li
                    key={item}
                    className="text-sm text-text-secondary leading-relaxed flex gap-2.5"
                  >
                    <span className="text-[oklch(0.75_0.15_55)] mt-1.5 w-1 h-1 rounded-full bg-current flex-shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </Reveal>
          ))}
        </div>

        {/* Flow diagram */}
        <Reveal delay={0.3} className="mt-16">
          <FlowDiagram />
        </Reveal>
      </div>
    </section>
  );
}

function FlowDiagram() {
  const nodes = [
    { label: "Agent", sub: "SDK / HTTP" },
    { label: "Policy Engine", sub: "Evaluate rules" },
    { label: "Proxy", sub: "Inject credentials" },
    { label: "Vault", sub: "Sign or forward" },
  ];

  return (
    <div className="flex items-center justify-between overflow-x-auto py-6">
      {nodes.map((node, i) => (
        <div key={node.label} className="flex items-center flex-1 min-w-0">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{
              delay: i * 0.15,
              duration: 0.4,
              ease: [0.25, 1, 0.5, 1],
            }}
            className="border border-border px-5 py-3 bg-bg-elevated flex-shrink-0"
          >
            <div className="text-sm font-display font-700">{node.label}</div>
            <div className="text-xs text-text-tertiary mt-0.5">{node.sub}</div>
          </motion.div>
          {i < nodes.length - 1 && (
            <motion.div
              initial={{ opacity: 0, scaleX: 0 }}
              whileInView={{ opacity: 1, scaleX: 1 }}
              viewport={{ once: true }}
              transition={{
                delay: i * 0.15 + 0.2,
                duration: 0.3,
                ease: [0.25, 1, 0.5, 1],
              }}
              className="flex-1 h-px bg-border origin-left mx-1 relative min-w-[16px]"
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-0 h-0 border-t-[4px] border-t-transparent border-b-[4px] border-b-transparent border-l-[6px] border-l-border" />
            </motion.div>
          )}
        </div>
      ))}
    </div>
  );
}

// --- SDK Section ---
function SDKSection() {
  const snippets = [
    {
      filename: "sign-transaction.ts",
      code: `import { StewardClient } from "@stwd/sdk"

const steward = new StewardClient({
  baseUrl: process.env.STEWARD_PROXY_URL,
  bearerToken: process.env.STEWARD_AGENT_TOKEN,
})

// Policy-enforced signing
const tx = await steward.signTransaction(agentId, {
  to: "0xDEX...",
  value: "100000000000000000",
})`,
    },
    {
      filename: "api-proxy.ts",
      code: `// Credentials injected — agent never sees the key
const openai = new OpenAI({
  baseURL: \`\${process.env.STEWARD_PROXY_URL}/openai/v1\`,
})

const completion = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "..." }],
})
// Costs tracked, rate-limited, audited`,
    },
    {
      filename: "policies.ts",
      code: `await steward.setPolicies(agentId, [
  { type: "spending-limit",
    config: { maxPerTx: "1e18",
              maxPerDay: "10e18" } },
  { type: "rate-limit",
    config: { window: "1m",
              maxRequests: 60 } },
  { type: "approved-addresses",
    config: { addresses: [
      "0xUniswap...",
      "0xTreasury..."] } },
])`,
    },
  ];

  return (
    <section className="relative px-6 md:px-10 py-32 md:py-40 border-t border-border-subtle">
      <div className="max-w-[1400px] mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-16">
          <div className="lg:col-span-4">
            <Reveal>
              <p className="text-sm text-text-tertiary tracking-widest uppercase mb-8">SDK</p>
            </Reveal>
            <Reveal delay={0.1}>
              <h2 className="font-display text-hero-sm font-800 tracking-tight leading-[1.05]">
                Sign transactions.
                <br />
                Proxy APIs.
                <br />
                Enforce everything.
              </h2>
            </Reveal>
            <Reveal delay={0.2}>
              <p className="mt-6 text-text-secondary leading-relaxed">
                TypeScript SDK for policy-checked signing and credential-injected API proxying.
                Works with any agent framework.
              </p>
            </Reveal>
            <Reveal delay={0.3}>
              <div className="mt-8">
                <code className="text-xs text-text-tertiary font-mono">npm i @stwd/sdk</code>
              </div>
            </Reveal>
          </div>

          <div className="lg:col-span-8 space-y-4">
            {snippets.map((snippet, i) => (
              <Reveal key={snippet.filename} delay={i * 0.1} direction="right">
                <div className="border border-border bg-bg-elevated">
                  <CodeBlock
                    filename={snippet.filename}
                    language="typescript"
                    code={snippet.code}
                  />
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// --- Specs (replaces generic stats) ---
function SpecsSection() {
  const specs = [
    { value: "AES-256-GCM", label: "Encryption at rest" },
    { value: "Default deny", label: "Policy model" },
    { value: "7 EVM + Solana", label: "Chains supported" },
    { value: "< 50ms", label: "Proxy overhead" },
  ];

  return (
    <section className="relative px-6 md:px-10 py-24 md:py-32 border-t border-border-subtle">
      <div className="max-w-[1400px] mx-auto">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border-subtle">
          {specs.map((spec, i) => (
            <Reveal key={spec.label} delay={i * 0.1} className="bg-bg p-8 md:p-10 text-center">
              <div className="font-display text-2xl md:text-3xl font-800 tracking-tight">
                {spec.value}
              </div>
              <div className="text-xs text-text-tertiary mt-2 tracking-wide uppercase">
                {spec.label}
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// --- For Platforms ---
function PlatformsSection() {
  return (
    <section className="relative px-6 md:px-10 py-32 md:py-40 border-t border-border-subtle">
      <div className="max-w-[1400px] mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-16">
          <div className="lg:col-span-7">
            <Reveal>
              <p className="text-sm text-text-tertiary tracking-widest uppercase mb-8">
                Works with any agent framework
              </p>
            </Reveal>
            <Reveal delay={0.1}>
              <h2 className="font-display text-hero-sm font-800 tracking-tight leading-[1.05]">
                Multi-tenant by default
              </h2>
            </Reveal>
            <Reveal delay={0.2}>
              <p className="mt-6 text-lg text-text-secondary leading-relaxed max-w-xl">
                One Steward instance for thousands of agents across isolated tenants. Each tenant
                gets its own policies, credentials, and webhook endpoints. Self-hosted. No
                per-transaction toll.
              </p>
            </Reveal>
          </div>

          <div className="lg:col-span-5 flex flex-col justify-center">
            <StaggerContainer staggerDelay={0.12} className="space-y-6">
              {[
                {
                  name: "DeFi & Trading",
                  desc: "Trading bots, yield agents, and liquidity managers with enforced spending limits and approved counterparties",
                },
                {
                  name: "AI Agent Platforms",
                  desc: "ElizaOS, LangChain, AutoGPT — any framework that needs secure wallet and API access for its agents",
                },
                {
                  name: "Treasuries & Rewards",
                  desc: "DAO treasuries, perks systems, and micro-payment agents with multi-party approval flows",
                },
                {
                  name: "RWA & Settlement",
                  desc: "Commodity finance, collateral management, and tokenized asset operations",
                },
              ].map((tenant) => (
                <StaggerItem key={tenant.name}>
                  <div className="border-l-2 border-border pl-6 py-2 hover:border-accent transition-colors">
                    <div className="font-display font-700 text-lg">{tenant.name}</div>
                    <div className="text-sm text-text-secondary mt-1">{tenant.desc}</div>
                  </div>
                </StaggerItem>
              ))}
            </StaggerContainer>
          </div>
        </div>
      </div>
    </section>
  );
}

// --- Open Source Banner ---
function OpenSourceSection() {
  return (
    <section className="relative px-6 md:px-10 py-32 md:py-40 border-t border-border-subtle">
      <div className="max-w-[1400px] mx-auto text-center">
        <Reveal>
          <p className="text-sm text-text-tertiary tracking-widest uppercase mb-8">Open source</p>
        </Reveal>
        <Reveal delay={0.1}>
          <h2 className="font-display text-hero-sm font-800 tracking-tight leading-[1.05] max-w-2xl mx-auto">
            Infrastructure you own, not a dependency you rent.
          </h2>
        </Reveal>
        <Reveal delay={0.2}>
          <p className="mt-6 text-lg text-text-secondary leading-relaxed max-w-xl mx-auto">
            MIT-licensed. Self-hostable. No per-transaction fees.
          </p>
        </Reveal>
        <Reveal delay={0.3}>
          <div className="mt-10 flex items-center justify-center gap-5">
            <a
              href="https://github.com/Steward-Fi/steward"
              target="_blank"
              rel="noopener noreferrer"
              className="px-6 py-3 border border-border text-text-secondary text-sm hover:text-text hover:border-text-tertiary transition-colors"
            >
              Browse the source
            </a>
            <a
              href="https://npmjs.com/package/@stwd/sdk"
              target="_blank"
              rel="noopener noreferrer"
              className="px-6 py-3 border border-border text-text-secondary text-sm hover:text-text hover:border-text-tertiary transition-colors"
            >
              npm i @stwd/sdk
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// --- Footer ---
function Footer() {
  return (
    <footer className="border-t border-border-subtle px-6 md:px-10 py-12">
      <div className="max-w-[1400px] mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div>
          <div className="flex items-center gap-2">
            <Image
              src="/logo.png"
              alt=""
              width={18}
              height={18}
              className="w-[18px] h-[18px] opacity-60"
            />
            <span className="font-display text-base font-bold tracking-tight">steward</span>
          </div>
          <p className="text-xs text-text-tertiary mt-1">
            Governance infrastructure for autonomous AI agents.
          </p>
        </div>
        <div className="flex items-center gap-6 text-sm text-text-tertiary">
          <a
            href="https://docs.steward.fi"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text transition-colors"
          >
            Docs
          </a>
          <a
            href="https://github.com/Steward-Fi/steward"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text transition-colors"
          >
            GitHub
          </a>
          <a
            href="https://npmjs.com/package/@stwd/sdk"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text transition-colors"
          >
            npm
          </a>
        </div>
      </div>
    </footer>
  );
}

// --- Main Page ---
export default function LandingPage() {
  return (
    <main>
      <Nav />
      <Hero />
      <ProblemSection />
      <ArchitectureSection />
      <SDKSection />
      <SpecsSection />
      <PlatformsSection />
      <OpenSourceSection />
      <Footer />
    </main>
  );
}
