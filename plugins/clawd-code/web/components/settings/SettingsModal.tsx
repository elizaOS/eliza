"use client";

import { useState } from "react";
import { useChatStore } from "@/lib/store";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SettingsNav, type SettingsSection } from "./SettingsNav";
import { GeneralSettings } from "./GeneralSettings";
import { ModelSettings } from "./ModelSettings";
import { ProviderSettings } from "./ProviderSettings";
import { ApiSettings } from "./ApiSettings";
import { TelegramSettings } from "./TelegramSettings";
import { PermissionSettings } from "./PermissionSettings";
import { McpSettings } from "./McpSettings";
import { KeyboardSettings } from "./KeyboardSettings";
import { DataSettings } from "./DataSettings";

const SECTION_COMPONENTS: Record<SettingsSection, React.ComponentType> = {
  general: GeneralSettings,
  model: ModelSettings,
  provider: ProviderSettings,
  api: ApiSettings,
  telegram: TelegramSettings,
  permissions: PermissionSettings,
  mcp: McpSettings,
  keyboard: KeyboardSettings,
  data: DataSettings,
};

export function SettingsModal() {
  const { settingsOpen, closeSettings } = useChatStore();
  const [active, setActive] = useState<SettingsSection>("provider");
  const [searchQuery, setSearchQuery] = useState("");

  const ActiveSection = SECTION_COMPONENTS[active];

  return (
    <Dialog open={settingsOpen} onOpenChange={(open) => !open && closeSettings()}>
      <DialogContent size="lg" className="flex flex-col p-0 max-h-[calc(100vh-4rem)]">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 min-h-0 px-6 pb-6 gap-4">
          <div className="flex flex-col gap-2 flex-shrink-0">
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search settings..."
              className="w-48 bg-surface-800 border border-surface-700 rounded-md px-2.5 py-1.5 text-xs text-surface-200 placeholder-surface-600 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <SettingsNav active={active} onChange={setActive} searchQuery={searchQuery} />
          </div>
          <div className="flex-1 min-w-0 overflow-y-auto pr-1">
            <ActiveSection />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
