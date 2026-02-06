/**
 * Installation section component for the landing page.
 * Displays CLI installation command with OS-specific tabs and copy functionality.
 */

"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/brand";
import { motion } from "framer-motion";

export default function Installation() {
  const [activeTab, setActiveTab] = useState<"macos" | "windows">("macos");
  const [copied, setCopied] = useState(false);

  const command =
    activeTab === "macos" ? "bun i -g @elizaos/cli" : "bun i -g @elizaos/cli";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="relative shrink-0 overflow-hidden">
      <div className="relative container mx-auto px-4 md:px-6 py-16 md:py-20 lg:py-40">
        {/* Hero heading */}
        <motion.h2
          className="text-xl sm:text-3xl md:text-4xl font-medium text-center mb-8 md:mb-16  max-w-7xl mx-auto px-4"
          style={{
            fontFamily: "var(--font-geist-sans)",
            lineHeight: "1.3",
            color: "#FFFFFF",
          }}
        >
          From your terminal to the cloud in seconds.
        </motion.h2>

        {/* Terminal command section */}
        <div className="max-w-3xl mx-auto px-4 mb-12 sm:mb-24">
          {/* Command display */}
          <div className="bg-[#161616BF] text-white pl-3 pr-2 py-2 md:pl-4 md:pr-3 md:py-3 flex items-center justify-between gap-2 md:gap-4 border border-white/10 hover:border-brand-orange hover:bg-black transition-all duration-300">
            <div className="flex items-center gap-2 md:gap-3 flex-1 min-w-0">
              <span className="shrink-0" style={{ color: "#FF5800" }}>
                ▸
              </span>
              <code className="text-sm md:text-base truncate select-all">
                {command}
              </code>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleCopy}
              className="shrink-0 h-8 w-8 md:h-10 md:w-10"
            >
              {copied ? (
                <Check className="size-4 md:size-5 text-brand-orange" />
              ) : (
                <Copy className="size-4 md:size-5 text-white/60 hover:text-white" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
