"use client";

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared-brand";
import { CloudVideoBackground } from "@elizaos/ui";
import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function HeroSection() {
  const navigate = useNavigate();
  const launchEliza = () => navigate("/login?intent=launch");
  const openDashboard = () => navigate("/login?intent=dashboard");

  return (
    <CloudVideoBackground
      basePath={BRAND_PATHS.clouds}
      speed="4x"
      poster={BRAND_PATHS.poster}
      scrim={0.18}
      scrimColor="rgba(255,255,255,1)"
      style={{ minHeight: "100vh" }}
    >
      <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col items-start justify-center px-6 py-28 text-black sm:px-10 lg:px-16">
        <img
          src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudBlack}`}
          alt="Eliza Cloud"
          className="mb-10 h-9 w-auto sm:h-11"
          draggable={false}
        />
        <h1
          className="max-w-4xl text-[clamp(3rem,14vw,10rem)] font-medium leading-[0.86] text-black"
          style={{ fontFamily: "Poppins, Arial, system-ui, sans-serif" }}
        >
          Run in Cloud.
        </h1>
        <p className="mt-6 max-w-xl text-xl font-light leading-snug text-black/80 sm:text-2xl">
          Your agent, always on.
        </p>
        <div className="mt-10 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap">
          <button
            type="button"
            onClick={launchEliza}
            className="inline-flex min-h-14 items-center justify-center gap-2 bg-black px-8 py-4 text-base font-medium text-white transition hover:bg-[#0B35F1] sm:text-lg"
            style={{ borderRadius: 2 }}
          >
            Launch Eliza
            <ArrowRight className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={openDashboard}
            className="inline-flex min-h-14 items-center justify-center bg-[#FF5800] px-7 py-4 text-base font-medium text-black transition hover:bg-black hover:text-white"
            style={{ borderRadius: 2 }}
          >
            Developer Dashboard
          </button>
        </div>
      </div>
    </CloudVideoBackground>
  );
}
