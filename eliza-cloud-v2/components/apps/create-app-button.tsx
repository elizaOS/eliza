/**
 * Create app button component that opens the create app dialog.
 * Provides a button trigger for creating new applications.
 */

"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreateAppDialog } from "./create-app-dialog";

export function CreateAppButton() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button
        onClick={() => setIsOpen(true)}
        className="bg-gradient-to-r from-[#FF5800] to-purple-600 hover:from-[#FF5800]/90 hover:to-purple-600/90 text-white"
        data-onboarding="apps-create"
      >
        <Plus className="h-4 w-4 mr-2" />
        Create App
      </Button>
      <CreateAppDialog open={isOpen} onOpenChange={setIsOpen} />
    </>
  );
}
