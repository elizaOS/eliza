"use client";

import { BrandButton } from "@elizaos/cloud-ui";
import { ArrowRight, MessageCircleQuestion, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "eliza-survey-banner-dismissed";
const SURVEY_URL = "https://tally.so/r/0Q8Z6y";

interface SurveyBannerProps {
  className?: string;
}

export function SurveyBanner({ className }: SurveyBannerProps) {
  const [dismissed, setDismissed] = useState(true); // Start hidden to prevent flash

  useEffect(() => {
    const isDismissed = localStorage.getItem(STORAGE_KEY) === "true";
    setDismissed(isDismissed);
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem(STORAGE_KEY, "true");
  };

  if (dismissed) {
    return null;
  }

  return (
    <div
      className={cn(
        "relative border border-[#FF5800]/40 bg-gradient-to-r from-[#FF5800]/15 via-[#FF5800]/10 to-[#FF5800]/5 rounded-lg overflow-hidden animate-in fade-in slide-in-from-top-2 duration-300 shadow-lg shadow-[#FF5800]/10",
        className,
      )}
    >
      <div className="px-5 py-4 md:px-6">
        {/* Mobile: stacked layout, Desktop: horizontal */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
          {/* Icon + Text */}
          <div className="flex items-center gap-4">
            <MessageCircleQuestion className="h-7 w-7 text-[#FF5800] flex-shrink-0" />

            <div className="flex flex-col gap-0.5">
              <p className="text-base font-semibold text-white">
                A few quick questions to personalize your experience
              </p>
              <p className="text-sm text-white/60 hidden sm:block">
                Help us tailor the platform to your needs
              </p>
            </div>
          </div>

          {/* CTA + Dismiss */}
          <div className="flex items-center gap-2 sm:gap-3">
            <BrandButton
              variant="primary"
              size="sm"
              asChild
              className="flex-1 sm:flex-none shadow-lg shadow-[#FF5800]/20"
            >
              <a
                href={SURVEY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5"
              >
                Take Survey
                <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </BrandButton>

            <button
              onClick={handleDismiss}
              className="p-2 hover:bg-white/10 rounded-md transition-colors"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4 text-neutral-500 hover:text-neutral-300" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
