/**
 * On-chain trust section component for the landing page.
 * Displays blockchain trust features, micropayment network visualization, and trust indicators.
 */

"use client";

import { Button } from "@/components/ui/button";
import { ArrowUpRight, Check } from "lucide-react";
import { CornerBrackets, SectionLabel, BrandCard } from "@/components/brand";
import MicropaymentNetwork from "./MicropaymentNetwork";
import Image from "next/image";
import { ReactFlowProvider } from "@xyflow/react";
import { motion } from "framer-motion";

export default function OnChainTrust() {
  const mockCardData = [
    {
      name: "Sage",
      description: "Your default AI companion",
      address: "0xA9E3...C14",
      image: "/cloud-agent-samples/1.png",
    },
    {
      name: "Nova",
      description: "Creative writing assistant",
      address: "0xB2F4...A27",
      image: "/cloud-agent-samples/2.png",
    },
    {
      name: "Atlas",
      description: "Data analysis expert",
      address: "0xC8D1...F93",
      image: "/cloud-agent-samples/3.png",
    },
    {
      name: "Echo",
      description: "Voice interaction specialist",
      address: "0xD4E2...B61",
      image: "/cloud-agent-samples/4.png",
    },
    {
      name: "Eliza",
      description: "Knowledge base curator",
      address: "0xE7A5...D48",
      image: "/avatars/eliza-default.png",
    },
    {
      name: "Pixel",
      description: "Image generation AI",
      address: "0xF1B8...E52",
      image: "/cloud-agent-samples/5.png",
    },
    {
      name: "Cipher",
      description: "Code optimization tool",
      address: "0xA3C9...F17",
      image: "/cloud-agent-samples/6.png",
    },
    {
      name: "Muse",
      description: "Music composition helper",
      address: "0xB6D2...C83",
      image: "/cloud-agent-samples/7.png",
    },
    {
      name: "Scout",
      description: "Research aggregator",
      address: "0xC9E4...A94",
      image: "/cloud-agent-samples/8.png",
    },
  ];
  return (
    <section className="relative w-full max-w-7xl shrink-0 py-8 md:py-12 lg:py-20 overflow-hidden mx-auto">
      <div className="flex flex-col px-4 relative z-10">
        {/* Header */}
        <div className="mb-8 md:mb-8 flex flex-col md:flex-row items-start md:justify-between gap-6">
          <div className="max-w-4xl">
            <motion.div className="mb-1 md:mb-2">
              <SectionLabel>
                <span className="normal-case">Build Autonomous Agents</span>
              </SectionLabel>
            </motion.div>

            <motion.h2
              className="mb-6 md:mb-12 text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-medium"
              style={{
                fontFamily: "var(--font-geist-sans)",
                lineHeight: "1.3",
                color: "#FFFFFF",
              }}
            >
              Onchain discovery, trust and payments.
            </motion.h2>

            <motion.p
              className="font-medium text-sm md:text-base text-neutral-400"
              style={{
                lineHeight: "1.5",
                letterSpacing: "-0.003em",
              }}
            >
              Fully autonomous agents that utilize 8004 & x402 to find agents,
              understand their reputation and securely take part in agentic
              commerce.
            </motion.p>
          </div>
        </div>

        {/* Two column layout */}
        <div className="grid gap-8 lg:grid-cols-2">
          {/* Left: 3x3 Grid of Agent wallet cards with radial fade */}
          <div className="relative">
            {/* 3x3 Grid container with radial mask */}
            <div
              className="grid grid-cols-3 gap-2 relative"
              style={{
                maskImage:
                  "radial-gradient(circle at center, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 25%, rgba(0,0,0,0.6) 50%, rgba(0,0,0,0.2) 75%, transparent 100%)",
                WebkitMaskImage:
                  "radial-gradient(circle at center, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 25%, rgba(0,0,0,0.6) 50%, rgba(0,0,0,0.2) 75%, transparent 100%)",
              }}
            >
              {mockCardData.map((agent, index) => {
                return (
                  <div
                    key={index}
                    className="border border-white/10 hover:border-white/60 p-3 duration-300 transition-all hover:z-10 cursor-pointer hover:brightness-110"
                    style={{
                      background: "rgba(10,10,10,0.9)",
                      boxShadow: "0 0 20px rgba(0,0,0,0.3)",
                      backdropFilter: "blur(10px)",
                    }}
                  >
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <div className="h-10 w-10 rounded-sm flex-shrink-0 relative overflow-hidden">
                          <Image
                            src={agent.image}
                            alt="Agent"
                            fill
                            sizes="40px"
                            className="object-cover select-none"
                            draggable={false}
                          />
                        </div>
                        <h3 className="select-none text-xs font-semibold text-white">
                          {agent.name}
                        </h3>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] select-none text-white/60 mb-1.5 line-clamp-1">
                          {agent.description}
                        </p>
                        <div
                          className="flex items-center gap-1 mb-1"
                          style={{ color: "#FF5800" }}
                        >
                          <Check className="h-2.5 w-2.5" />
                          <span className="text-[10px] select-none">
                            ERC-8004 Verified
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-white/40">
                          <svg
                            className="h-2.5 w-2.5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M15 7a2 2 0 0 1 2 2m4 0a6 6 0 0 1-7.743 5.743L11 17H9v2H7v2H4a1 1 0 0 1-1-1v-2.586a1 1 0 0 1 .293-.707l5.964-5.964A6 6 0 1 1 21 9z"
                            />
                          </svg>
                          <span className="text-[10px] font-mono select-none">
                            {agent.address}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: Network visualization */}
          <BrandCard
            corners={false}
            className="flex min-h-[400px] items-center justify-center bg-black/90"
          >
            <div className="w-full">
              <ReactFlowProvider>
                <MicropaymentNetwork />
              </ReactFlowProvider>
            </div>
          </BrandCard>
        </div>

        {/* Bottom tagline */}
        {/*   <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{
            duration: 1,
            ease: [0.25, 0.1, 0.25, 1],
            delay: 0.2,
          }}
          className="mt-12 md:mt-16 text-center px-4"
        >
          <p className="uppercase text-base sm:text-lg md:text-xl lg:text-2xl tracking-wider text-white">
            Agents discover each other, build trust, and transact.{" "}
            <span className="uppercase text-white/60">All on-chain.</span>
          </p>
        </motion.div> */}
      </div>
    </section>
  );
}
