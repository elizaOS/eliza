/** Linux website navigation shares the owned Chromium profile with its native bridge. */
import { type ReactNode, useCallback, useState } from "react";
import { openBrowserWebsite } from "../../bridge/system-browser";
import { Button } from "../ui/button";
import { BrowserPasswordsDialog } from "./BrowserPasswordsDialog";
import { ChromiumBrowserEntry } from "./ChromiumBrowserEntry";

export function LinuxChromiumBrowser({
  workspace,
}: {
  workspace: ReactNode;
}): React.JSX.Element {
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [passwordsOpen, setPasswordsOpen] = useState(false);
  const openPasswords = useCallback(async () => {
    setPasswordsOpen(true);
  }, []);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav
        aria-label="Browser views"
        className="flex gap-2 border-b border-border px-5 py-3"
      >
        <Button
          variant={showWorkspace ? "ghost" : "secondary"}
          aria-pressed={!showWorkspace}
          onClick={() => setShowWorkspace(false)}
        >
          Websites
        </Button>
        <Button
          variant={showWorkspace ? "secondary" : "ghost"}
          aria-pressed={showWorkspace}
          onClick={() => setShowWorkspace(true)}
        >
          App and agent tabs
        </Button>
      </nav>
      <div hidden={showWorkspace} className="min-h-0 flex-1">
        <ChromiumBrowserEntry
          openWebsite={openBrowserWebsite}
          openPasswords={openPasswords}
          openedMessage="Chromium opened in its own window. Return to Eliza to continue with your agent."
        />
      </div>
      {showWorkspace && <div className="min-h-0 flex-1">{workspace}</div>}
      <BrowserPasswordsDialog
        open={passwordsOpen}
        onOpenChange={setPasswordsOpen}
      />
    </div>
  );
}
