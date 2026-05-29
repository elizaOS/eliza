/**
 * Create app button component that opens the create app dialog.
 * Provides a button trigger for creating new applications.
 */

"use client";

import { Button } from "@elizaos/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useT } from "@/providers/I18nProvider";
import { CreateAppDialog } from "./create-app-dialog";

export function CreateAppButton() {
  const t = useT();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button
        onClick={() => setIsOpen(true)}
        className="bg-[#FF5800] hover:bg-black hover:text-white text-white"
        data-onboarding="apps-create"
      >
        <Plus className="h-4 w-4 mr-2" />
        {t("cloud.apps.createApp", { defaultValue: "Create App" })}
      </Button>
      <CreateAppDialog open={isOpen} onOpenChange={setIsOpen} />
    </>
  );
}
