/**
 * Top hero section component for the landing page.
 * Displays CLI commands for creating and deploying agents with OS-specific tabs.
 * Includes copy-to-clipboard functionality and call-to-action buttons.
 */

"use client";

import { useState, useEffect } from "react";
import { Copy, Check, Terminal, Rocket, Code2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandButton, CornerBrackets } from "@/components/brand";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";

const TopHero = () => {
  const [activeOS, setActiveOS] = useState<"unix" | "windows">("unix");
  const [copied, setCopied] = useState<string | null>(null);
  const [deployingDots, setDeployingDots] = useState(0);
  const [isDeploying, setIsDeploying] = useState(true);
  const [cursorLine, setCursorLine] = useState<"deploy" | "deploying" | "url">(
    "deploy",
  );
  const [status, setStatus] = useState<"create" | "deploy">("create");
  const router = useRouter();

  useEffect(() => {
    let timeout: NodeJS.Timeout | null = null;

    const switchToDeploy = () => {
      setStatus("deploy");
      // After 10 seconds in deploy, switch back to create
      timeout = setTimeout(() => {
        switchToCreate();
      }, 10000);
    };

    const switchToCreate = () => {
      setStatus("create");
      // Reset deploy panel state
      setCursorLine("deploy");
      setIsDeploying(true);
      setDeployingDots(0);
      // After 3 seconds in create, switch to deploy
      timeout = setTimeout(() => {
        switchToDeploy();
      }, 3000);
    };

    // Start the loop: create → deploy after 3 seconds
    timeout = setTimeout(() => {
      switchToDeploy();
    }, 3000);

    return () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };
  }, []);

  useEffect(() => {
    if (status !== "deploy") return;

    // Reset cursor to deploy line when deploy status starts
    setCursorLine("deploy");

    // Move cursor to deploying line when it appears (1s after deploy starts)
    const deployingTimeout = setTimeout(() => {
      setCursorLine("deploying");
    }, 1000);

    // Move cursor to URL line when it appears (6s after deploy starts)
    const urlTimeout = setTimeout(() => {
      setCursorLine("url");
    }, 6000);

    return () => {
      clearTimeout(deployingTimeout);
      clearTimeout(urlTimeout);
    };
  }, [status]);

  useEffect(() => {
    if (status !== "deploy") {
      setIsDeploying(true);
      setDeployingDots(0);
      return;
    }

    let interval: NodeJS.Timeout | null = null;

    // Reset state when deploy starts
    setIsDeploying(true);
    setDeployingDots(0);

    // Wait for the text to appear (1s delay + 0.3s animation duration = 1.3s)
    const startDelay = setTimeout(() => {
      let stepCount = 0;
      const totalSteps = 12; // 3 cycles × 4 states (1, 2, 3, 0)

      setDeployingDots(1);
      stepCount = 1;

      interval = setInterval(() => {
        stepCount++;
        const positionInCycle = stepCount % 4;
        // Cycle: 1, 2, 3, 0
        if (positionInCycle === 0) {
          setDeployingDots(0);
        } else {
          setDeployingDots(positionInCycle);
        }

        if (stepCount >= totalSteps) {
          setIsDeploying(false);
          setDeployingDots(3);
          if (interval) clearInterval(interval);
        }
      }, 333);
    }, 1300);

    return () => {
      clearTimeout(startDelay);
      if (interval) clearInterval(interval);
    };
  }, [status]);

  const commands = {
    unix: {
      create: "bunx elizaos create my-agent",
      deploy: "bunx elizaos deploy",
    },
    windows: {
      create: "bunx elizaos create my-agent",
      deploy: "bunx elizaos deploy",
    },
  };

  const handleCopy = async (command: string, key: string) => {
    await navigator.clipboard.writeText(command);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleGetStarted = () => {
    router.push("/login?intent=signup");
  };

  const steps = [
    {
      icon: <Terminal className="h-5 w-5" />,
      title: "Create",
    },
    {
      icon: <Code2 className="h-5 w-5" />,
      title: "Develop",
    },
    {
      icon: <Rocket className="h-5 w-5" />,
      title: "Deploy",
    },
  ];

  return (
    <section className="w-full flex items-center shrink-0 py-24 lg:py-36 relative overflow-hidden">
      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <div className="mx-auto max-w-5xl text-center">
          {/* Headline */}
          <motion.h1
            className="mb-6 md:mb-6 font-normal tracking-tight relative z-10 text-balance"
            style={{ textShadow: "0 2px 10px rgba(0,0,0,0.5)" }}
          >
            <span className="text-4xl mx-3 md:text-5xl lg:text-6xl xl:text-7xl font-bold">
              Build Agents,
            </span>{" "}
            <span className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl xl:text-7xl text-neutral-400 sm:text-neutral-500">
              Not Infrastructure
            </span>
          </motion.h1>

          {/* Subhead */}
          <motion.p
            className="mb-10 md:mb-16 text-sm sm:text-base md:text-lg lg:text-xl text-white mx-auto relative z-10 px-4 max-w-4xl"
            style={{ textShadow: "0 1px 8px rgba(0,0,0,0.4)" }}
          >
            <span className={status === "create" ? "bg-brand-orange" : ""}>
              Create
            </span>{" "}
            and{" "}
            <span className={status === "deploy" ? "bg-brand-orange" : ""}>
              deploy
            </span>{" "}
            AI agents in one command. Open source. Zero lock-in.
          </motion.p>

          {/* Terminal Display */}
          <div className="relative mx-auto max-w-3xl mb-2 md:mb-4">
            {status === "create" && (
              <CornerBrackets size="md" color="#FF5800" />
            )}
            {/* Create command */}
            <div className="flex items-center justify-between gap-2 bg-[#161616BF] border border-white/15 rounded px-3 py-2.5">
              <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
                <span
                  style={{ color: status === "create" ? "#FF5800" : "white" }}
                >
                  ▸
                </span>
                <code className="text-sm sm:text-base text-white whitespace-nowrap select-all">
                  {commands[activeOS].create}
                </code>
              </div>
              <button
                onClick={() => handleCopy(commands[activeOS].create, "create")}
                className="shrink-0 p-1.5 text-white/60 hover:text-white transition-colors"
                aria-label="Copy command"
              >
                {copied === "create" ? (
                  <Check className="h-4 w-4 text-[#FF5800]" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {/* Bottom section with features and terminal */}
          <div className="relative mx-auto max-w-3xl mb-10 md:mb-16">
            {status === "deploy" && (
              <CornerBrackets size="md" color="#FF5800" />
            )}
            <div className="bg-[#161616BF] border border-white/15 overflow-hidden text-start">
              {/* Terminal header */}
              <div className="bg-[#161616BF] border-b border-white/10 pl-4 md:pl-6 pr-2 md:pr-3 flex h-10 md:h-12 items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 md:w-3 md:h-3 rounded-full bg-[#A2A2A2]" />
                  <div className="w-2.5 h-2.5 md:w-3 md:h-3 rounded-full bg-[#A2A2A2]" />
                  <div className="w-2.5 h-2.5 md:w-3 md:h-3 rounded-full bg-[#A2A2A2]" />
                </div>

                <button
                  onClick={() =>
                    handleCopy(commands[activeOS].deploy, "deploy")
                  }
                  className="shrink-0 p-1.5 text-white/60 hover:text-white transition-colors"
                  aria-label="Copy command"
                >
                  {copied === "deploy" ? (
                    <Check className="h-4 w-4 text-[#FF5800]" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>

              {/* Terminal content */}
              <div className="p-4 md:p-6 text-sm md:text-base">
                <div className="flex items-center gap-2">
                  <span className="text-[#FF5800]">$</span>
                  <span className="text-white select-all">
                    npx elizaos deploy
                  </span>
                  {cursorLine === "deploy" && status === "deploy" && (
                    <span
                      className="inline-block w-0.5 h-3.5 bg-white ml-px"
                      style={{
                        animation: "blink 1s step-end infinite",
                      }}
                    />
                  )}
                </div>
                <motion.div
                  className="flex items-center gap-2"
                  initial={{ opacity: 0 }}
                  animate={
                    status === "deploy" ? { opacity: 1 } : { opacity: 0 }
                  }
                  transition={{
                    duration: 0.3,
                    delay: status === "deploy" ? 1 : 0,
                  }}
                >
                  <span className="text-[#00BE4C]">
                    {isDeploying ? "Deploying" : "Deployed"}
                    {isDeploying ? ".".repeat(deployingDots) : " ✓"}
                  </span>
                  {cursorLine === "deploying" && status === "deploy" && (
                    <span
                      className="inline-block w-0.5 h-3.5 bg-white ml-px"
                      style={{
                        animation: "blink 1s step-end infinite",
                      }}
                    />
                  )}
                </motion.div>
                <motion.div
                  className="text-white/70"
                  initial={{ opacity: 0 }}
                  animate={
                    status === "deploy" ? { opacity: 1 } : { opacity: 0 }
                  }
                  transition={{
                    duration: 0.4,
                    delay: status === "deploy" ? 5.6 : 0,
                  }}
                >
                  Running on Eliza Cloud
                </motion.div>
                <motion.div
                  className="flex items-center gap-2 text-[#FF5800] break-all"
                  initial={{ opacity: 0 }}
                  animate={
                    status === "deploy" ? { opacity: 1 } : { opacity: 0 }
                  }
                  transition={{
                    duration: 0.4,
                    delay: status === "deploy" ? 6 : 0,
                  }}
                >
                  → https://my-agent.containers.elizacloud.ai
                  {cursorLine === "url" && status === "deploy" && (
                    <span
                      className="inline-block w-0.5 h-3.5 bg-white ml-px shrink-0"
                      style={{
                        animation: "blink 1s step-end infinite",
                      }}
                    />
                  )}
                </motion.div>
              </div>
            </div>
          </div>

          {/* CTAs */}
          <motion.div className="flex flex-col md:flex-row max-w-3xl mx-auto items-center justify-center gap-2 sm:gap-6">
            <BrandButton
              variant="primary"
              size="lg"
              onClick={handleGetStarted}
              className="w-full md:w-auto min-w-[176px] text-base group border border-[#FF5800] bg-[#FF5800] text-white hover:bg-[#FF5800]/90 active:bg-[#FF5800]/80"
            >
              Start Building
              <ArrowRight className="ml-2 h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
            </BrandButton>
            <Button
              variant="outline"
              size="lg"
              className="w-full md:w-auto min-w-[176px] h-12 text-base bg-transparent border-white/60 text-white hover:bg-white hover:text-black dark:bg-transparent dark:border-white/60 dark:text-white dark:hover:bg-white dark:hover:text-black"
              onClick={() => router.push("/docs")}
            >
              Docs
            </Button>
          </motion.div>

          {/* Journey Steps */}
          {/* <div className="grid grid-cols-3 gap-2 md:gap-4 max-w-xl mx-auto">
            {steps.map((step, index) => (
              <div key={step.title} className="relative group">
                <div className="flex flex-col items-center text-center p-4">
                  <div
                    className="w-12 h-12 flex items-center justify-center mb-3 transition-colors"
                    style={{
                      backgroundColor: "rgba(255, 88, 0, 0.1)",
                      border: "1px solid rgba(255, 88, 0, 0.3)",
                    }}
                  >
                    <div style={{ color: "#FF5800" }}>{step.icon}</div>
                  </div>
                  <h3 className="text-lg font-semibold text-white">
                    {step.title}
                  </h3>
                </div>
              </div>
            ))}
          </div> */}
        </div>
      </div>
    </section>
  );
};

export default TopHero;
