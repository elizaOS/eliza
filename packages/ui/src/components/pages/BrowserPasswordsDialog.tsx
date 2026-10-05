/** Hands password lifecycle tasks to the owner's local provider without reading its vault. */
import { ExternalLink, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { openBrowserWebsite } from "../../bridge/system-browser";
import {
  defaultPasswordProviderSettings,
  loadPasswordProviderSettings,
  type PasswordProvider,
  type PasswordProviderSettings,
  savePasswordProviderSettings,
  validatePasswordProviderUrl,
} from "../../platform/password-provider-settings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const PROVIDERS = {
  bitwarden: {
    name: "Bitwarden",
    extension: "https://bitwarden.com/download/#downloads-web-browser",
    desktop: "https://bitwarden.com/download/#downloads-desktop",
    setup: "https://bitwarden.com/help/getting-started-browserext/",
    server: "https://bitwarden.com/help/change-client-environment/",
    generate: "https://bitwarden.com/help/generator/",
    fill: "https://bitwarden.com/help/auto-fill-browser/",
    change: "https://bitwarden.com/help/getting-started-browserext/",
    sync: "https://bitwarden.com/help/vault-sync/",
    backup: "https://bitwarden.com/help/encrypted-export/",
    recovery: "https://bitwarden.com/help/forgot-master-password/",
    lock: "https://bitwarden.com/help/vault-timeout/",
    regions: [
      ["US", "https://vault.bitwarden.com/"],
      ["EU", "https://vault.bitwarden.eu/"],
    ],
  },
  "1password": {
    name: "1Password",
    extension: "https://1password.com/downloads/browser-extension",
    desktop: "https://1password.com/downloads",
    setup: "https://support.1password.com/getting-started-browser/",
    server: "https://support.1password.com/regions/",
    generate: "https://support.1password.com/getting-started-browser/",
    fill: "https://support.1password.com/getting-started-browser/",
    change: "https://support.1password.com/generate-website-password/",
    sync: "https://support.1password.com/sync/",
    backup: "https://support.1password.com/export/",
    recovery: "https://support.1password.com/recovery-codes/",
    lock: "https://support.1password.com/unlock-auto-lock/",
    regions: [
      ["US", "https://my.1password.com/"],
      ["EU", "https://my.1password.eu/"],
      ["Canada", "https://my.1password.ca/"],
    ],
  },
} as const;

export function BrowserPasswordsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-4 sm:max-w-xl">
        <DialogHeader className="pr-7">
          <DialogTitle className="flex items-center gap-2">
            <KeyRound
              className="size-5 shrink-0 text-accent-action"
              aria-hidden
            />
            Passwords & passkeys
          </DialogTitle>
          <DialogDescription>
            Manage your passwords in your browser’s password manager on this
            device.
          </DialogDescription>
        </DialogHeader>
        {open && <PasswordProviderPanel />}
      </DialogContent>
    </Dialog>
  );
}

function PasswordProviderPanel(): React.JSX.Element {
  const [settings, setSettings] = useState(defaultPasswordProviderSettings);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void loadPasswordProviderSettings().then(
      (value) => {
        if (!active) return;
        setSettings(value);
        setReady(true);
      },
      () => {
        // error-policy:J4 An unreadable local destination is never opened by default.
        if (!active) return;
        setLoadFailed(true);
        setError(
          "Could not read your saved setup. Reset it to choose a provider again.",
        );
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const provider = PROVIDERS[settings.provider];
  function update(next: PasswordProviderSettings) {
    setSettings(next);
    setSaved(false);
    setError(null);
  }
  function setAddress(value: string) {
    update({
      ...settings,
      webVaults: { ...settings.webVaults, [settings.provider]: value },
    });
  }
  async function launch(url: string) {
    setBusy(true);
    setError(null);
    try {
      await openBrowserWebsite(url);
    } catch {
      // error-policy:J4 Browser dispatch failure is visible and is not retried.
      setError(
        "Could not open the browser. Check that your browser is installed, then try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function openVault() {
    try {
      const url = validatePasswordProviderUrl(
        settings.provider,
        settings.webVaults[settings.provider],
      );
      await launch(url);
    } catch (cause) {
      // error-policy:J3 Destination validation fails before a browser is opened.
      setError(
        cause instanceof Error
          ? cause.message
          : "Check your web vault address.",
      );
    }
  }
  async function save(reset = false) {
    setBusy(true);
    setError(null);
    try {
      const value = reset ? defaultPasswordProviderSettings() : settings;
      await savePasswordProviderSettings(value);
      setSettings(value);
      setSaved(true);
      setLoadFailed(false);
      setReady(true);
    } catch {
      // error-policy:J4 Failed writes never show a saved confirmation.
      setError(
        "Could not save this setup. Check the HTTPS address and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  function link(label: string, url: string) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="min-h-10 whitespace-normal"
        disabled={busy}
        onClick={() => void launch(url)}
      >
        {label}
        <ExternalLink className="ml-1 size-3.5 shrink-0" aria-hidden />
      </Button>
    );
  }
  const help = [
    {
      title: "Generate & save",
      text: "In your manager, add a login with the website address and use its password generator. Save it when the website accepts the new account or password.",
      url: provider.generate,
    },
    {
      title: "Fill, view & use passkeys",
      text: "Unlock your manager in the browser toolbar. Choose the matching login to fill, or open its details to view a password. Create or use passkeys from the website’s sign-in or security settings.",
      url: provider.fill,
    },
    {
      title: "Change or reset a password",
      text: "Use the website’s account security page or Forgot password flow. Generate the replacement in your manager and update the saved login after the website accepts it. Editing a saved login alone does not change the website password.",
      url: provider.change,
    },
    {
      title: "Sync across devices",
      text: "Sign in to the same provider account and server on each device. Use the provider’s sync controls and check the saved login on the other device before replacing or erasing this one.",
      url: provider.sync,
    },
    {
      title: "Back up your vault",
      text:
        settings.provider === "bitwarden"
          ? "Use a password-protected encrypted JSON export in Bitwarden. Keep its password separately and check what the export includes. Sync alone is not a backup."
          : "1Password desktop exports are not encrypted. Follow its export instructions and keep any exported file protected. Check which item types are included before relying on an export.",
      url: provider.backup,
    },
    {
      title: "Recover account access",
      text: "Keep your provider’s recovery materials separately from your vault. Use its recovery process if you cannot sign in; recovery options depend on your account. Eliza cannot reset your master password.",
      url: provider.recovery,
    },
    {
      title: "Lock & unlock",
      text: "Use Lock in the provider extension or app, and set its automatic timeout. Unlock there when needed. Closing Eliza does not lock a separate password manager.",
      url: provider.lock,
    },
  ];
  return (
    <div className="min-h-0 space-y-4 overflow-y-auto pr-1 text-sm">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 p-3 text-danger"
        >
          {error}
        </p>
      )}
      {loadFailed ? (
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => void save(true)}
        >
          Reset local setup
        </Button>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="browser-password-provider">Password manager</Label>
        <select
          id="browser-password-provider"
          className="min-h-11 w-full rounded-md border border-border bg-bg px-3 text-txt"
          value={settings.provider}
          disabled={!ready || busy}
          onChange={(event) =>
            update({
              ...settings,
              provider: event.target.value as PasswordProvider,
            })
          }
        >
          <option value="bitwarden">Bitwarden</option>
          <option value="1password">1Password</option>
        </select>
        <p className="text-xs text-muted">
          Install the extension in your everyday browser profile, then sign in
          and unlock there. Your passwords stay with {provider.name}.
        </p>
        <div className="flex flex-wrap gap-2">
          {link("Get browser extension", provider.extension)}
          {link("Get desktop app", provider.desktop)}
          {link("Setup help", provider.setup)}
        </div>
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer font-medium">
            Open or pin {provider.name}
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted">
            <li>
              In Chromium or Chrome, click Extensions (the puzzle-piece icon)
              beside the address bar.
            </li>
            <li>
              Click {provider.name} to open it. To keep it visible, click the
              thumbtack beside its name.
            </li>
            <li>
              Click its toolbar icon whenever you need to sign in, unlock, or
              find a saved login.
            </li>
          </ol>
          <p className="mt-2 text-xs text-muted">
            Not listed? Use Get browser extension above in this browser profile,
            then follow Setup help.
          </p>
        </details>
      </div>
      <Button
        variant="accentDarkHover"
        className="min-h-11 w-full"
        disabled={!ready || busy}
        onClick={() => void openVault()}
      >
        Open {provider.name} web vault
        <ExternalLink className="ml-2 size-4" aria-hidden />
      </Button>
      <details className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer font-medium">
          Account & server settings
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted">
            Choose the region where your account already exists
            {settings.provider === "bitwarden"
              ? ", or your self-hosted web vault"
              : ", or enter your team’s account address"}
            . Select the same server inside your provider. This shortcut does
            not move your vault or configure the extension.
          </p>
          <div className="flex flex-wrap gap-2">
            {provider.regions.map(([name, url]) => (
              <Button
                key={name}
                variant="outline"
                size="sm"
                disabled={!ready || busy}
                onClick={() => setAddress(url)}
              >
                {name}
              </Button>
            ))}
          </div>
          <Label htmlFor="browser-password-server">Web vault address</Label>
          <Input
            id="browser-password-server"
            value={settings.webVaults[settings.provider]}
            onChange={(event) => setAddress(event.target.value)}
            disabled={!ready || busy}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
          />
          <p className="text-xs text-muted">
            Only your provider choice and address are remembered on this device.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!ready || busy}
              variant="outline"
              onClick={() => void save()}
            >
              Remember setup
            </Button>
            {link("Server help", provider.server)}
          </div>
          {saved && (
            <p role="status" className="text-xs text-muted">
              Setup saved on this device.
            </p>
          )}
        </div>
      </details>
      <div className="divide-y divide-border rounded-lg border border-border px-3">
        {help.map((item) => (
          <details key={item.title} className="py-3">
            <summary className="cursor-pointer font-medium">
              {item.title}
            </summary>
            <div className="mt-2 space-y-2">
              <p className="text-xs leading-relaxed text-muted">{item.text}</p>
              {link(`${item.title} help`, item.url)}
            </div>
          </details>
        ))}
      </div>
      <p className="text-xs text-muted">
        Your provider shows whether it is locked and up to date. Eliza does not
        read that status or your vault contents here.
      </p>
    </div>
  );
}
