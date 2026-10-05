/** Android owns its Chromium and credential-manager handoffs. */
import { registerPlugin } from "@capacitor/core";
import { useAndroidChromiumAgentControl } from "../../hooks/useAndroidChromiumAgentControl";
import { ChromiumBrowserEntry } from "./ChromiumBrowserEntry";

export { chromiumAddress } from "./ChromiumBrowserEntry";

const browser = registerPlugin<{
  openBrowser(options: { url: string }): Promise<{
    packageName: string;
    engine: "chromium";
    surface: "custom-tab";
  }>;
}>("ElizaSurfaceManager");
const credentials = registerPlugin<{ open(): Promise<void> }>(
  "CredentialManager",
);
const openWebsite = async (url: string) => {
  await browser.openBrowser({ url });
};
const openPasswords = async () => {
  await credentials.open();
};

const getWebsiteHint = (url: string): string | null =>
  new URL(url).hostname === "web.whatsapp.com"
    ? "If WhatsApp asks you to use a computer, open Chromium’s menu (⋮) and choose Desktop site. Chromium remembers this setting for WhatsApp."
    : null;

export function AndroidChromiumBrowser(): React.JSX.Element {
  useAndroidChromiumAgentControl();
  return (
    <ChromiumBrowserEntry
      openWebsite={openWebsite}
      openPasswords={openPasswords}
      getWebsiteHint={getWebsiteHint}
      openedMessage="Chromium opened. Use Android Back to return to Eliza."
    />
  );
}
