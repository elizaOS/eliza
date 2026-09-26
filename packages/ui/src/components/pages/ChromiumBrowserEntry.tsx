/** Opens websites in the installed Chromium browser and leaves credentials and page state with that browser. */
import { Globe, KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { NAVIGATE_VIEW_EVENT, type NavigateViewDetail } from "../../events";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { BrowserSearchSettings } from "./BrowserSearchSettings";

export function chromiumAddress(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter a website or search term.");
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
  const candidate = hasScheme
    ? value
    : /\s/.test(value) || !value.includes(".")
      ? `https://www.google.com/search?q=${encodeURIComponent(value)}`
      : `https://${value}`;
  const url = new URL(candidate);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Enter an http or https website without a username or password in the address.",
    );
  }
  return url.href;
}

const destinations = [
  { name: "Google", url: "https://www.google.com/" },
  { name: "Facebook", url: "https://www.facebook.com/" },
  { name: "Instagram", url: "https://www.instagram.com/" },
  { name: "WhatsApp", url: "https://web.whatsapp.com/" },
];

export function ChromiumBrowserEntry({
  openWebsite,
  openPasswords,
  openedMessage,
  getWebsiteHint,
}: {
  openWebsite: (url: string) => Promise<void>;
  openPasswords: () => Promise<void>;
  openedMessage: string;
  getWebsiteHint?: (url: string) => string | null;
}): React.JSX.Element {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchedUrl, setDispatchedUrl] = useState<string | null>(null);

  const open = useCallback(
    async (value: string) => {
      setError(null);
      setDispatchedUrl(null);
      setBusy(true);
      try {
        const url = chromiumAddress(value);
        await openWebsite(url);
        setDispatchedUrl(url);
      } catch (failure) {
        // error-policy:J4 Native browser absence or dispatch failure remains visible and requires a user retry.
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not open Chromium. Check that the browser is installed and enabled.",
        );
      } finally {
        setBusy(false);
      }
    },
    [openWebsite],
  );

  const initialNavigationHandled = useRef(false);
  useEffect(() => {
    if (!initialNavigationHandled.current) {
      initialNavigationHandled.current = true;
      const search =
        window.location.search || window.location.hash.split("?")[1] || "";
      const initialUrl = new URLSearchParams(search).get("browse");
      if (initialUrl) void open(initialUrl);
    }
    const onNavigation = (event: Event) => {
      const detail = (event as CustomEvent<NavigateViewDetail>).detail;
      if (detail?.viewId !== "browser" || !detail.viewPath) return;
      const query = detail.viewPath.split("?")[1];
      const url = new URLSearchParams(query).get("browse");
      if (url) void open(url);
    };
    window.addEventListener(NAVIGATE_VIEW_EVENT, onNavigation);
    return () => window.removeEventListener(NAVIGATE_VIEW_EVENT, onNavigation);
  }, [open]);

  async function showPasswords() {
    setError(null);
    try {
      await openPasswords();
    } catch {
      // error-policy:J4 Credential setup cannot be opened; no vault or unlocked state is inferred.
      setError("Could not open password settings. Please try again.");
    }
  }

  const websiteHint = dispatchedUrl ? getWebsiteHint?.(dispatchedUrl) : null;

  return (
    <section
      aria-label="Browser"
      className="flex h-full min-h-0 flex-col overflow-auto bg-bg p-5 sm:p-8"
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-txt">
              <Globe aria-hidden="true" /> Browser
            </h1>
            <p className="mt-2 text-sm text-muted">
              Browse with Chromium. Your browser remembers your tabs and
              sign-ins.
            </p>
          </div>
          <Button
            variant="outline"
            className="shrink-0"
            onClick={() => void showPasswords()}
          >
            <KeyRound aria-hidden="true" /> Passwords
          </Button>
        </div>
        <form
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            void open(address);
          }}
        >
          <Input
            aria-label="Website or search"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="Search or enter a website"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            className="min-h-12 flex-1"
          />
          <Button
            type="submit"
            variant="accentDarkHover"
            disabled={busy || !address.trim()}
            className="min-h-12"
          >
            {busy ? "Opening…" : "Go"}
          </Button>
        </form>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {destinations.map((destination) => (
            <Button
              key={destination.name}
              variant="outline"
              disabled={busy}
              className="min-h-14"
              onClick={() => void open(destination.url)}
            >
              {destination.name}
            </Button>
          ))}
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-danger p-4 text-sm text-danger"
          >
            {error}
          </p>
        )}
        {dispatchedUrl && (
          <p role="status" className="text-sm text-muted">
            {openedMessage}
            {websiteHint && <span className="mt-2 block">{websiteHint}</span>}
          </p>
        )}
        <BrowserSearchSettings />
        <p className="text-sm text-muted">
          Save and fill passwords with your password manager. Website sign-in
          and passkey prompts stay in the browser.
        </p>
      </div>
    </section>
  );
}
