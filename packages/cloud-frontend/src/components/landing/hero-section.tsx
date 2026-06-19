"use client";

import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";

export default function HeroSection() {
  const navigate = useNavigate();
  const t = useT();
  const launchEliza = () => navigate("/login?intent=launch");

  return (
    <div
      className="relative w-full"
      style={{ minHeight: "100svh", background: "var(--background)" }}
    >
      <div className="relative mx-auto flex min-h-[100svh] w-full max-w-7xl flex-col items-start justify-center px-6 py-28 text-white sm:px-10 lg:px-16">
        <h1
          className="w-full whitespace-nowrap text-[clamp(1.75rem,6.8vw,6rem)] font-medium leading-[0.86] text-white"
          style={{ fontFamily: "Poppins, Arial, system-ui, sans-serif" }}
        >
          {t("cloud.landing.heroTitle", {
            defaultValue: "Your Agent. Anywhere.",
          })}
        </h1>
        <p className="mt-6 max-w-2xl text-xl font-medium leading-snug text-white/80 sm:text-2xl">
          {t("cloud.landing.heroSubtitle", {
            defaultValue: "Hosting, APIs and commerce tools for agents.",
          })}
        </p>
        <div className="mt-10 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap">
          <button
            type="button"
            onClick={launchEliza}
            className="inline-flex min-h-14 items-center justify-center gap-2 rounded-[3px] bg-white px-8 py-4 text-base font-medium text-black transition-colors hover:bg-white/85 sm:text-lg"
          >
            {t("cloud.landing.launchEliza", { defaultValue: "Launch Eliza" })}
            <ArrowRight className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
