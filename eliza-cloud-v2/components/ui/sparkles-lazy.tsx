/**
 * Lazy-loaded wrapper for SparklesCore component.
 * Dynamically imports @tsparticles (~400KB) only when needed.
 */

"use client";

import dynamic from "next/dynamic";

// Dynamic import to reduce initial bundle size
const SparklesCore = dynamic(
  () => import("./sparkles").then((mod) => ({ default: mod.SparklesCore })),
  {
    ssr: false,
    loading: () => <div className="opacity-0" />,
  },
);

export { SparklesCore };
