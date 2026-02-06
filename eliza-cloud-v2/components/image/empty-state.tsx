/**
 * Empty state component for image generator when no prompt has been entered.
 */

"use client";

import { Image as ImageIcon } from "lucide-react";

export function EmptyState() {
  return (
    <div className="rounded-none border border-dashed border-white/10 p-8 text-center bg-black/20 hover:border-[#FF5800]/30 transition-colors duration-300">
      <div className="flex flex-col items-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[#FF5800]/10 border border-[#FF5800]/40">
          <ImageIcon className="h-6 w-6 text-[#FF5800]" />
        </div>
        <p className="mt-3 text-sm text-white/50">Enter a prompt to generate</p>
      </div>
    </div>
  );
}
