/**
 * Lazy-loaded wrapper for BayerDitheringBackground component.
 * Reduces initial bundle size by code-splitting Three.js dependencies.
 */

"use client";

import dynamic from "next/dynamic";
import { ComponentProps } from "react";

const BayerDitheringBackgroundComponent = dynamic(
  () => import("./BayerDitheringBackground"),
  {
    ssr: false,
    loading: () => (
      <div className="fixed inset-0 bg-gradient-to-br from-zinc-950 via-black to-zinc-900" />
    ),
  },
);

export type BayerDitheringBackgroundProps = ComponentProps<
  typeof BayerDitheringBackgroundComponent
>;

export const BayerDitheringBackgroundLazy = (
  props: BayerDitheringBackgroundProps,
) => {
  return <BayerDitheringBackgroundComponent {...props} />;
};
