/**
 * Lazy-loaded wrapper for MicropaymentNetwork component.
 * Dynamically imports @xyflow/react (~500KB) only when needed.
 */

"use client";

import dynamic from "next/dynamic";
import { ReactFlowProvider } from "@xyflow/react";
import { Loader2 } from "lucide-react";

// Dynamic import to reduce initial bundle size
const MicropaymentNetwork = dynamic(() => import("./MicropaymentNetwork"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-[280px] w-full">
      <Loader2 className="h-6 w-6 animate-spin text-white/40" />
    </div>
  ),
});

export function MicropaymentNetworkLazy() {
  return (
    <ReactFlowProvider>
      <MicropaymentNetwork />
    </ReactFlowProvider>
  );
}
