"use client";

import { ArrowRight, Cloud, Code, Database, Server } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function HeroSection() {
  const navigate = useNavigate();

  return (
    <div className="w-full max-w-5xl mx-auto px-6 sm:px-8 z-40">
      {/* Hero Heading */}
      <div className="text-center mb-12 sm:mb-16">
        <h1
          className="text-4xl sm:text-6xl md:text-7xl font-bold text-white leading-tight max-w-4xl mx-auto tracking-tight"
          style={{ fontFamily: "var(--font-inter)" }}
        >
          Monetize your agents
        </h1>
        <p className="text-lg sm:text-xl md:text-2xl text-white/70 mt-6 max-w-2xl mx-auto font-light leading-relaxed">
          Eliza Cloud is everything you need to bootstrap and monetize agents and AI apps.
        </p>

        <div className="flex items-center justify-center mt-10">
          <button
            type="button"
            onClick={() => navigate("/login?intent=signup")}
            className="inline-flex items-center gap-2 rounded-full bg-[#FF5800] px-8 py-4 text-base sm:text-lg font-medium text-white shadow-lg shadow-[#FF5800]/30 transition-all hover:bg-[#e54e00] hover:scale-105 font-[family-name:var(--font-inter)]"
          >
            Get Started Free
            <ArrowRight className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Feature Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6 mt-16 sm:mt-24">
        {[
          {
            icon: Cloud,
            label: "Cloud Services",
            desc: "Scalable infrastructure",
          },
          { icon: Code, label: "Powerful APIs", desc: "Build without limits" },
          { icon: Server, label: "Secure Hosting", desc: "Enterprise grade" },
          {
            icon: Database,
            label: "Advanced LLMs",
            desc: "State of the art models",
          },
        ].map((feature, i) => (
          <div
            key={i}
            className="bg-black/60 backdrop-blur-xl border border-white/10 rounded-2xl p-6 flex flex-col items-center text-center shadow-xl shadow-black/40 transition-all hover:bg-black/70 hover:border-white/20"
          >
            <div className="h-12 w-12 rounded-xl bg-white/10 flex items-center justify-center mb-4 text-white/80">
              <feature.icon className="h-6 w-6 text-[#FF5800]" />
            </div>
            <h3 className="text-white font-medium mb-1">{feature.label}</h3>
            <p className="text-white/50 text-sm">{feature.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
