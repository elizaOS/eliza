/**
 * Create-app trigger button + dialog.
 */

import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { CreateAppDialog } from "./create-app-dialog";

export function CreateAppButton() {
  const t = useCloudT();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button
        onClick={() => setIsOpen(true)}
        className="bg-[#FF5800] hover:bg-[#e54f00] text-black"
        data-onboarding="apps-create"
      >
        <Plus className="h-4 w-4 mr-2" />
        {t("cloud.apps.createApp", { defaultValue: "Create App" })}
      </Button>
      <CreateAppDialog open={isOpen} onOpenChange={setIsOpen} />
    </>
  );
}
