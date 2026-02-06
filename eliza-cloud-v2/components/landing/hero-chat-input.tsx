/**
 * Hero chat input component for the landing page.
 * Displays a textarea with animated typing placeholder.
 */

"use client";

import { useState } from "react";
import {
  ArrowUp,
  Plus,
  FileText,
  ImageIcon,
  Globe,
  Sparkles,
  Zap,
  MessageSquare,
  Bot,
  Rocket,
  Lightbulb,
} from "lucide-react";
import { useTypingPlaceholder } from "@/lib/hooks/use-typing-placeholder";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

interface HeroChatInputProps {
  onSubmit?: () => void;
}

const appQuickPrompts = [
  { label: "Task Manager", prompt: "Build a task manager app", icon: Zap },
  {
    label: "AI Chatbot",
    prompt: "Build an AI chatbot app",
    icon: MessageSquare,
  },
  { label: "Marketplace", prompt: "Build a marketplace app", icon: Rocket },
  { label: "Social Feed", prompt: "Build a social feed app", icon: Globe },
  { label: "Dashboard", prompt: "Build a dashboard app", icon: Lightbulb },
  { label: "E-commerce", prompt: "Build an e-commerce app", icon: Sparkles },
  { label: "Portfolio", prompt: "Build a portfolio app", icon: Bot },
  { label: "Blog Site", prompt: "Build a blog site app", icon: FileText },
  { label: "Quiz Game", prompt: "Build a quiz game app", icon: Zap },
  { label: "Weather App", prompt: "Build a weather app", icon: Globe },
];

const agentQuickPrompts = [
  { label: "Writer", prompt: "Create a creative writer", icon: Sparkles },
  { label: "Coder", prompt: "Create a coding helper", icon: Bot },
  { label: "Researcher", prompt: "Create a research agent", icon: Lightbulb },
  { label: "Translator", prompt: "Create a translator bot", icon: Globe },
  { label: "Tutor", prompt: "Create a learning tutor", icon: MessageSquare },
  { label: "Analyst", prompt: "Create a data analyst", icon: Zap },
  { label: "Chef", prompt: "Create a recipe helper", icon: Rocket },
  { label: "Fitness", prompt: "Create a fitness coach", icon: Zap },
  { label: "Therapist", prompt: "Create a wellness guide", icon: Lightbulb },
  { label: "Planner", prompt: "Create a travel planner", icon: Globe },
];

const STORAGE_KEY = "hero-chat-input";

export default function HeroChatInput({ onSubmit }: HeroChatInputProps) {
  const [prompt, setPrompt] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [mode, setMode] = useState<"agent" | "app">("app");

  const quickPrompts = mode === "app" ? appQuickPrompts : agentQuickPrompts;

  const handleSubmit = () => {
    if (!prompt.trim() || !onSubmit) return;
    // Save to localStorage before navigating to signup
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ prompt, mode }));
    } catch {
      // Ignore - private browsing or storage full, continue with signup anyway
    }
    onSubmit();
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const appPlaceholders = [
    "Build a note-taking app with AI",
    "Create a habit tracker with reminders",
    "Make an inventory tracking tool",
  ];

  const agentPlaceholders = [
    "Create a personal finance advisor",
    "Build a meeting scheduler assistant",
    "Make a writing coach for my essays",
  ];

  const placeholderSentences =
    mode === "app" ? appPlaceholders : agentPlaceholders;
  const typingPlaceholder = useTypingPlaceholder(placeholderSentences, mode);

  return (
    <div className="w-full max-w-3xl mx-auto px-4">
      {/* Hero Heading */}
      <div className="text-center mb-8">
        <h1
          className="text-3xl sm:text-5xl md:text-6xl font-bold text-white leading-tight whitespace-nowrap"
          style={{ fontFamily: "var(--font-inter)" }}
        >
          Build something real
        </h1>
        <p className="text-lg sm:text-xl md:text-2xl text-white/70 mt-2">
          Create apps and agents by chatting with AI
        </p>

        {/* App/Agent Toggle Switch */}
        <div className="flex justify-center items-center gap-3 mt-8 mb-[-24px]">
          <span
            className={`text-sm transition-colors ${
              mode === "app" ? "text-white" : "text-white/50"
            }`}
          >
            App
          </span>
          <button
            type="button"
            onClick={() => setMode(mode === "app" ? "agent" : "app")}
            className="relative w-14 h-[22px] bg-neutral-900/70 backdrop-blur-xl rounded-full transition-colors"
            aria-label="Toggle between App and Agent"
          >
            {/* Left dot (visible when agent is active) */}
            <span
              className={`absolute top-[7px] left-[7px] w-2 h-2 rounded-full transition-opacity duration-200 ${
                mode === "agent" ? "bg-white/40" : "opacity-0"
              }`}
            />
            {/* Right dot (visible when app is active) */}
            <span
              className={`absolute top-[7px] right-[7px] w-2 h-2 rounded-full transition-opacity duration-200 ${
                mode === "app" ? "bg-white/40" : "opacity-0"
              }`}
            />
            {/* Main toggle circle */}
            <span
              className={`absolute top-[3px] w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${
                mode === "agent" ? "left-[34px]" : "left-[3px]"
              }`}
            />
          </button>
          <span
            className={`text-sm transition-colors ${
              mode === "agent" ? "text-white" : "text-white/50"
            }`}
          >
            Agent
          </span>
        </div>
      </div>

      <div className="bg-neutral-900/70 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl">
        <div className="relative">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyPress}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder=""
            className="w-full h-28 sm:h-24 px-4 sm:px-5 py-3 sm:py-4 text-white text-base sm:text-lg bg-transparent resize-none focus:outline-none rounded-xl sm:rounded-2xl relative z-10"
            rows={3}
          />
          {/* Animated placeholder - hidden when focused or has content */}
          {!prompt && !isFocused && (
            <div className="absolute top-3 sm:top-4 left-4 sm:left-5 text-base sm:text-lg text-neutral-200 pointer-events-none flex items-center">
              <span>{typingPlaceholder}</span>
              <span className="inline-block w-[2px] h-[1.2em] bg-neutral-400 ml-[1px] animate-blink" />
            </div>
          )}
        </div>
        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-2 sm:px-4 pb-2 sm:pb-4">
          {/* Left side - Plus menu and App/Agent switch */}
          <div className="flex items-center gap-2">
            {/* Plus Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] transition-colors"
                >
                  <Plus className="h-4 w-4 text-neutral-400 hover:text-white" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-56 rounded-xl border-white/10 bg-neutral-800/60 backdrop-blur-md p-1.5"
                align="start"
                side="top"
                sideOffset={8}
              >
                <DropdownMenuItem
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer data-[highlighted]:bg-white/5 focus:bg-white/5"
                  onSelect={() => onSubmit?.()}
                >
                  <FileText className="h-4 w-4 text-white/50" />
                  <span className="text-sm">Upload files</span>
                </DropdownMenuItem>

                <DropdownMenuItem
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer data-[highlighted]:bg-white/5 focus:bg-white/5"
                  onSelect={() => onSubmit?.()}
                >
                  <ImageIcon className="h-4 w-4 text-white/50" />
                  <span className="text-sm">Create image</span>
                </DropdownMenuItem>

                <DropdownMenuItem
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer data-[highlighted]:bg-white/5 focus:bg-white/5"
                  onSelect={() => onSubmit?.()}
                >
                  <Globe className="h-4 w-4 text-white/50" />
                  <span className="text-sm">Web search</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Submit Button */}
          <button
            onClick={handleSubmit}
            disabled={!prompt.trim()}
            className="size-8 rounded-lg bg-[#FF5800] hover:bg-[#e54e00] disabled:bg-white/10 transition-all flex items-center justify-center group"
            aria-label="Submit"
          >
            <ArrowUp className="size-4 text-white group-disabled:text-neutral-400" />
          </button>
        </div>
      </div>

      {/* Quick Prompt Tabs - Marquee */}
      <div
        className="mt-4 overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
        }}
      >
        <div
          className="flex w-max hover:[animation-play-state:paused]"
          style={{ animation: "marquee 30s linear infinite" }}
        >
          <div className="flex gap-2 pr-2">
            {quickPrompts.map((item) => (
              <button
                key={item.label}
                onClick={() => setPrompt(item.prompt)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-white/20 bg-white/10 hover:bg-white/20 hover:border-white/40 transition-all text-xs sm:text-sm text-white/70 hover:text-white whitespace-nowrap flex-shrink-0"
              >
                <item.icon className="w-3.5 h-3.5" />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <div className="flex gap-2 pr-2">
            {quickPrompts.map((item) => (
              <button
                key={`${item.label}-dup`}
                onClick={() => setPrompt(item.prompt)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-white/20 bg-white/10 hover:bg-white/20 hover:border-white/40 transition-all text-xs sm:text-sm text-white/70 hover:text-white whitespace-nowrap flex-shrink-0"
              >
                <item.icon className="w-3.5 h-3.5" />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
        <style>{`
          @keyframes marquee {
            0% { transform: translateX(0); }
            100% { transform: translateX(-50%); }
          }
        `}</style>
      </div>
    </div>
  );
}
