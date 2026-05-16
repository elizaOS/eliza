"use client";

import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function HeroSection() {
  const navigate = useNavigate();

  return (
    <div className="z-40 mx-auto grid w-full max-w-7xl items-center gap-10 px-6 sm:px-8 lg:grid-cols-[minmax(0,0.88fr)_minmax(26rem,0.72fr)] lg:gap-8">
      <div className="max-w-3xl text-left max-lg:mx-auto max-lg:text-center">
        <h1
          className="text-5xl font-bold leading-[0.95] text-white drop-shadow-[0_12px_40px_rgba(0,24,122,0.42)] sm:text-7xl md:text-8xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Your Eliza in the cloud.
        </h1>
        <p className="mt-6 max-w-md text-xl font-light leading-relaxed text-white/86 drop-shadow-[0_2px_14px_rgba(0,24,122,0.24)] max-lg:mx-auto sm:text-2xl">
          Chat, manage, and keep your agent online.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-3 max-lg:justify-center">
          <button
            type="button"
            onClick={() => navigate("/login?intent=signup")}
            className="inline-flex items-center gap-2 rounded-full bg-white px-9 py-4 font-[family-name:var(--font-body)] text-base font-semibold text-[#0647ff] shadow-[0_24px_64px_rgba(0,24,122,0.34)] transition-all hover:scale-105 hover:bg-white/92 sm:text-lg"
          >
            Open Cloud
            <ArrowRight className="h-5 w-5" />
          </button>
          <a
            href="https://eliza.app"
            className="inline-flex items-center gap-2 rounded-full border border-white/36 bg-white/12 px-6 py-4 font-[family-name:var(--font-body)] text-base font-semibold text-white shadow-[0_18px_46px_rgba(0,24,122,0.18)] backdrop-blur-xl transition-all hover:bg-white/22 sm:text-lg"
          >
            Get App
          </a>
          <a
            href="https://elizaos.ai"
            className="inline-flex items-center gap-2 rounded-full border border-white/36 bg-white/12 px-6 py-4 font-[family-name:var(--font-body)] text-base font-semibold text-white shadow-[0_18px_46px_rgba(0,24,122,0.18)] backdrop-blur-xl transition-all hover:bg-white/22 sm:text-lg"
          >
            Install OS
          </a>
        </div>
      </div>

      <div className="pointer-events-none relative hidden min-h-[34rem] lg:block">
        <div className="absolute inset-y-[-9rem] right-[-7rem] w-[43rem]">
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
