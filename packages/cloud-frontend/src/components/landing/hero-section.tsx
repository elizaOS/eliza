"use client";

import { CloudVideoBackground } from "@elizaos/ui";
import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function HeroSection() {
  const navigate = useNavigate();

  return (
    <CloudVideoBackground
      basePath="/clouds"
      speed="4x"
      poster="/clouds/poster.jpg"
      scrim={0.72}
      scrimColor="rgba(0,0,0,1)"
      style={{ minHeight: "100vh" }}
    >
      <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col items-start justify-center px-6 py-28 text-white sm:px-10 lg:px-16">
        <img
          src="/brand/logos/elizacloud_logotext.svg"
          alt="eliza cloud"
          className="mb-10 h-10 w-auto sm:h-12"
          draggable={false}
        />
        <h1
          className="max-w-4xl text-[clamp(4rem,14vw,10rem)] font-extrabold leading-[0.86] text-white"
          style={{ fontFamily: "Poppins, Arial, system-ui, sans-serif" }}
        >
          Run in Cloud.
        </h1>
        <p className="mt-6 max-w-2xl text-xl font-medium leading-snug text-white/78 sm:text-2xl">
          Sign in to launch your always-on Eliza agent.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/login?intent=signup")}
            className="inline-flex min-h-14 items-center justify-center gap-2 bg-white px-8 py-4 text-base font-semibold text-black transition hover:bg-white/85 sm:text-lg"
            style={{ borderRadius: 0 }}
          >
            Run in Cloud
            <ArrowRight className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() =>
              navigate("/checkout?collection=elizaos-hardware")
            }
            className="inline-flex min-h-14 items-center justify-center border border-white/40 bg-transparent px-7 py-4 text-base font-semibold text-white transition hover:bg-white hover:text-black"
            style={{ borderRadius: 0 }}
          >
            Preorder
          </button>
        </div>
      </div>
    </CloudVideoBackground>
  );
}
