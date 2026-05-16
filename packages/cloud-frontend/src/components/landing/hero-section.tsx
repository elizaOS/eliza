"use client";

import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

const appUrl = import.meta.env.VITE_ELIZA_APP_URL || "https://eliza.app";
const osUrl = import.meta.env.VITE_ELIZA_OS_URL || "https://elizaos.ai";

export default function HeroSection() {
  const navigate = useNavigate();

  return (
    <div className="z-40 mx-auto grid w-full max-w-7xl items-center gap-7 px-5 py-6 sm:gap-10 sm:px-8 sm:py-8 lg:grid-cols-[minmax(0,0.88fr)_minmax(26rem,0.72fr)] lg:gap-8 lg:py-0">
      <div className="max-w-3xl text-left max-lg:mx-auto max-lg:text-center">
        <h1
          className="text-[clamp(3.25rem,17vw,5.8rem)] font-bold leading-[0.92] text-white drop-shadow-[0_12px_40px_rgba(0,24,122,0.42)] sm:text-7xl md:text-8xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Your Eliza in the cloud.
        </h1>
        <p className="mt-5 max-w-sm text-lg font-light leading-relaxed text-white/88 drop-shadow-[0_2px_14px_rgba(0,24,122,0.24)] max-lg:mx-auto sm:mt-6 sm:max-w-md sm:text-2xl">
          Your agent, always online.
        </p>

        <div className="mt-8 flex flex-col items-stretch gap-3 max-lg:mx-auto max-lg:max-w-sm sm:mt-10 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center lg:justify-start">
          <button
            type="button"
            onClick={() => navigate("/login?intent=signup")}
            className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full bg-white px-9 py-4 font-[family-name:var(--font-body)] text-base font-semibold text-[#0647ff] shadow-[0_24px_64px_rgba(0,24,122,0.34)] transition-all hover:scale-105 hover:bg-white/92 sm:text-lg"
          >
            Open Eliza Cloud
            <ArrowRight className="h-5 w-5" />
          </button>
          <div className="flex items-center justify-center gap-2 sm:gap-3">
            <a
              href={appUrl}
              className="inline-flex min-h-12 items-center justify-center rounded-full border border-white/36 bg-white/12 px-5 py-3 font-[family-name:var(--font-body)] text-sm font-semibold text-white shadow-[0_18px_46px_rgba(0,24,122,0.18)] backdrop-blur-xl transition-all hover:bg-white/22 sm:px-6 sm:text-base"
            >
              Get App
            </a>
            <a
              href={osUrl}
              className="inline-flex min-h-12 items-center justify-center rounded-full border border-white/36 bg-white/12 px-5 py-3 font-[family-name:var(--font-body)] text-sm font-semibold text-white shadow-[0_18px_46px_rgba(0,24,122,0.18)] backdrop-blur-xl transition-all hover:bg-white/22 sm:px-6 sm:text-base"
            >
              Install OS
            </a>
          </div>
        </div>
      </div>

      <div className="pointer-events-none relative hidden min-h-[34rem] lg:block">
        <div className="absolute inset-y-[-4rem] right-[-5rem] w-[39rem] xl:right-[-7rem] xl:w-[43rem]">
          <img
            alt=""
            className="h-full w-full object-contain drop-shadow-[0_32px_90px_rgba(0,20,120,0.42)]"
            draggable={false}
            src="/brand/elizaos-phone.png"
          />
        </div>
      </div>
    </div>
  );
}
