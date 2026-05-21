"use client";

import { BRAND_PATHS } from "@elizaos/shared/brand";
import { CloudVideoBackground } from "@elizaos/ui";
import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";

export default function HeroSection() {
  const navigate = useNavigate();
  const t = useT();
  const launchEliza = () => navigate("/login?intent=launch");

  return (
    <CloudVideoBackground
      basePath={BRAND_PATHS.clouds}
      speed="4x"
      poster={BRAND_PATHS.poster}
      scrim={0.18}
      scrimColor="rgba(255,255,255,1)"
      style={{ minHeight: "100svh" }}
    >
      <div className="relative mx-auto flex min-h-[100svh] w-full max-w-7xl flex-col items-start justify-center px-6 py-28 text-black sm:px-10 lg:px-16">
        <h1
          className="max-w-4xl text-[clamp(3rem,14vw,10rem)] font-medium leading-[0.86] text-black"
          style={{ fontFamily: "Poppins, Arial, system-ui, sans-serif" }}
        >
          {t("cloud.landing.heroTitle", { defaultValue: "Launch Eliza." })}
        </h1>
        <p className="mt-6 max-w-xl text-xl font-light leading-snug text-black/80 sm:text-2xl">
          {t("cloud.landing.heroSubtitle", {
            defaultValue: "Your agent, always online.",
          })}
        </p>
        <div className="mt-10 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap">
          <button
            type="button"
            onClick={launchEliza}
            className="inline-flex min-h-14 items-center justify-center gap-2 rounded-[3px] border border-black bg-black px-8 py-4 text-base font-medium text-white transition-colors hover:bg-white hover:text-black sm:text-lg"
          >
            {t("cloud.landing.launchEliza", { defaultValue: "Launch Eliza" })}
            <ArrowRight className="h-5 w-5" />
          </button>
        </div>
      </div>
    </CloudVideoBackground>
  );
}
