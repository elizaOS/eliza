"use client";

import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function HeroSection() {
  const navigate = useNavigate();

  return (
    <div className="z-40 mx-auto w-full max-w-4xl px-6 sm:px-8">
      <div className="text-center">
        <h1
          className="mx-auto max-w-4xl text-4xl font-bold leading-tight text-white drop-shadow-[0_8px_34px_rgba(4,49,93,0.34)] sm:text-6xl md:text-7xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Your Eliza, already in the cloud.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg font-light leading-relaxed text-white/84 drop-shadow-[0_2px_14px_rgba(4,49,93,0.2)] sm:text-xl">
          Chat with your Eliza and manage your cloud agent from one account.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/login?intent=signup")}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-8 py-4 font-[family-name:var(--font-body)] text-base font-semibold text-primary-fg shadow-[0_18px_46px_rgba(217,95,22,0.32)] transition-all hover:scale-105 hover:bg-accent-hover sm:text-lg"
          >
            Open eliza cloud
            <ArrowRight className="h-5 w-5" />
          </button>
          <a
            href="https://eliza.app"
            className="inline-flex items-center gap-2 rounded-full border border-white/42 bg-white/18 px-6 py-4 font-[family-name:var(--font-body)] text-base font-semibold text-white shadow-[0_18px_46px_rgba(4,49,93,0.18)] backdrop-blur-xl transition-all hover:bg-white/28 sm:text-lg"
          >
            Get the App
          </a>
          <a
            href="https://elizaos.ai"
            className="inline-flex items-center gap-2 rounded-full border border-white/42 bg-white/18 px-6 py-4 font-[family-name:var(--font-body)] text-base font-semibold text-white shadow-[0_18px_46px_rgba(4,49,93,0.18)] backdrop-blur-xl transition-all hover:bg-white/28 sm:text-lg"
          >
            Install The OS
          </a>
        </div>
      </div>
    </div>
  );
}
