/**
 * Owns the Contacts page chrome in the plugin that owns the address-book
 * surface, keeping the shared UI package free of Contacts-specific framing.
 */

import { ViewHeader } from "@elizaos/ui/components";
import { ContactsView } from "./ContactsView.tsx";

export function ContactsPage(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <ViewHeader title="Contacts" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ContactsView />
      </div>
    </div>
  );
}
