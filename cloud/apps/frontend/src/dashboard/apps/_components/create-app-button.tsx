/**
 * Create app button component that opens the create app dialog.
 * Provides a button trigger for creating new applications.
 */

"use client";

import { Button } from "@elizaos/cloud-ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { CreateAppDialog } from "./create-app-dialog";

export function CreateAppButton() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button
        onClick={() => setIsOpen(true)}
        className="bg-[#FF5800] hover:bg-[#FF5800]/90 text-white"
        data-onboarding="apps-create"
      >
        <Plus className="h-4 w-4 mr-2" />
        Create App
      </Button>
      <CreateAppDialog open={isOpen} onOpenChange={setIsOpen} />
    </>
  );
}
