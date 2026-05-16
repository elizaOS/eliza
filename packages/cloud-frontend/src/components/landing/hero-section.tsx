"use client";

import { CloudVideoBackground } from "@elizaos/ui";
import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

const appUrl = import.meta.env.VITE_ELIZA_APP_URL || "https://eliza.app";
const osUrl = import.meta.env.VITE_ELIZA_OS_URL || "https://elizaos.ai";

export default function HeroSection() {
  const navigate = useNavigate();

  return (
    <CloudVideoBackground
      basePath="/clouds"
      speed="4x"
      poster="/clouds/poster.jpg"
      scrim={0.08}
      scrimColor="rgba(255,255,255,0.6)"
      style={{ minHeight: "100vh" }}
    >
      <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col items-start justify-center px-6 py-32 sm:px-10 lg:px-16">
        <img
          src="/brand/logos/elizacloud_logotext_black.svg"
          alt="eliza cloud"
          className="mb-10 h-10 w-auto sm:h-12"
          draggable={false}
        />
        <h1
          className="max-w-4xl text-[clamp(3rem,9vw,7rem)] font-extrabold leading-[0.95] tracking-tight text-black"
          style={{ fontFamily: "Poppins, system-ui, sans-serif" }}
        >
          Your eliza,
          <br />
          in the cloud.
        </h1>
        <p className="mt-6 max-w-2xl text-xl font-medium leading-snug text-black sm:text-2xl">
          Always online. Always yours. Run an agent that never sleeps.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/login?intent=signup")}
            className="inline-flex min-h-14 items-center justify-center gap-2 bg-black px-8 py-4 text-base font-semibold text-white transition hover:bg-black/85 sm:text-lg"
            style={{ borderRadius: 0 }}
          >
            Open Eliza Cloud
            <ArrowRight className="h-5 w-5" />
          </button>
          <a
            href={appUrl}
            className="inline-flex min-h-14 items-center justify-center border border-black bg-transparent px-7 py-4 text-base font-semibold text-black transition hover:bg-black hover:text-white"
            style={{ borderRadius: 0 }}
          >
            Get the app
          </a>
          <a
            href={osUrl}
            className="inline-flex min-h-14 items-center justify-center border border-black bg-transparent px-7 py-4 text-base font-semibold text-black transition hover:bg-black hover:text-white"
            style={{ borderRadius: 0 }}
          >
            Install elizaOS
          </a>
        </div>
      </div>
    </CloudVideoBackground>
  );
}
