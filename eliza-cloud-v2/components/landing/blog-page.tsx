"use client";

import LandingHeader from "@/components/layout/landing-header";
import Footer from "@/components/landing/Footer";
import BayerDitheringBackground from "./BayerDitheringBackground";

interface BlogPageProps {
  children: React.ReactNode;
}

export function BlogPage({ children }: BlogPageProps) {
  return (
    <div className="flex h-screen bg-black">
      <BayerDitheringBackground />

      <div className="relative z-30 flex w-full flex-col overflow-y-scroll sm:scrollbar-thin sm:scrollbar-thumb-brand-orange sm:scrollbar-track-black">
        <LandingHeader />

        {children}

        <Footer />
      </div>
    </div>
  );
}
