"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { BrandButton } from "@/components/brand";
import { QuickCreateDialog } from "@/components/builders";

export function AppsEmptyState() {
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  return (
    <>
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-4">
        <h3 className="text-lg font-medium text-neutral-500">No apps yet</h3>
        <BrandButton
          onClick={() => setShowCreateDialog(true)}
          className="h-9 md:h-10 bg-[#FF5800] text-white hover:bg-[#FF5800]/90 active:bg-[#FF5800]/80"
        >
          <Sparkles className="h-4 w-4" />
          Build with AI
        </BrandButton>
      </div>

      <QuickCreateDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        defaultType="app"
      />
    </>
  );
}
