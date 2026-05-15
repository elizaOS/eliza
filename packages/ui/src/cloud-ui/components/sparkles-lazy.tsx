/**
 * Lazy-loaded wrapper for SparklesCore component.
 * Dynamically imports @tsparticles (~400KB) only when needed.
 */

"use client";

import dynamic from "../runtime/dynamic";
import type { ParticlesProps } from "./sparkles";

// Dynamic import to reduce initial bundle size
const SparklesCore = dynamic<ParticlesProps>(
  () => import("./sparkles").then((mod) => ({ default: mod.SparklesCore })),
  {
    ssr: false,
    loading: () => <div className="opacity-0" />,
  },
);

export { SparklesCore };
