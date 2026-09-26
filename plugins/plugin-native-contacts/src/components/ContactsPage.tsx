/**
 * Owns the Contacts page chrome in the plugin that owns the address-book
 * surface, keeping the shared UI package free of Contacts-specific framing.
 */

import { PluginPageFrame } from "@elizaos/ui/components";
import { ContactsView } from "./ContactsView.tsx";

export function ContactsPage(): React.JSX.Element {
  return (
    <PluginPageFrame title="Contacts" contentOverflow="auto">
      <ContactsView />
    </PluginPageFrame>
  );
}
