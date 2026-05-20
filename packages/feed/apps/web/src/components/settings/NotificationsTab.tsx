"use client";

import {
  cn,
  DEFAULT_NOTIFICATION_DIGEST_SETTINGS,
  type NotificationDigestSettings,
} from "@feed/shared";
import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/useAuth";

type DigestFrequency = NotificationDigestSettings["frequency"];
type DeliveryChannel = NotificationDigestSettings["deliveryChannel"];

const frequencyOptions: { value: DigestFrequency; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const channelOptions: { value: DeliveryChannel; label: string }[] = [
  { value: "in-app", label: "In-app" },
  { value: "email", label: "Email" },
  { value: "both", label: "Both" },
];

/**
 * Notifications tab for Settings page.
 *
 * Covers Tier 2 (Performance digest) settings only:
 * - Tier 1 (outcome notifications) is always on — not shown here
 * - Tier 3 (feed signals) is part of the feed — not shown here
 */
export function NotificationsTab() {
  const { authenticated, getAccessToken } = useAuth();
  const [settings, setSettings] = useState<NotificationDigestSettings>(
    DEFAULT_NOTIFICATION_DIGEST_SETTINGS,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authenticated) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    const loadSettings = async () => {
      setIsLoading(true);
      setError(null);

      const token = await getAccessToken();
      if (!token) {
        if (!cancelled) {
          setIsLoading(false);
        }
        return;
      }

      const response = await fetch("/api/notifications/digest-settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = (await response.json().catch(() => ({}))) as {
        settings?: NotificationDigestSettings;
      };

      if (!cancelled) {
        if (response.ok && payload.settings) {
          setSettings(payload.settings);
          setError(null);
        } else {
          setError("Unable to load digest settings.");
        }
        setIsLoading(false);
      }
    };

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  const saveSettings = async (nextSettings: NotificationDigestSettings) => {
    const previousSettings = settings;
    setSettings(nextSettings);
    setIsSaving(true);
    setError(null);

    const token = await getAccessToken();
    if (!token) {
      setSettings(previousSettings);
      setIsSaving(false);
      setError("Unable to save digest settings.");
      return;
    }

    const response = await fetch("/api/notifications/digest-settings", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(nextSettings),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      settings?: NotificationDigestSettings;
    };

    if (response.ok && payload.settings) {
      setSettings(payload.settings);
      setError(null);
    } else {
      setSettings(previousSettings);
      setError("Unable to save digest settings.");
    }

    setIsSaving(false);
  };

  if (isLoading) {
    return <div className="text-muted-foreground text-sm">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Performance Digest */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Performance Digest</h3>
          <p className="mt-0.5 text-muted-foreground text-sm">
            Summary of how you and your agents performed.
          </p>
        </div>
        <Switch
          checked={settings.digestEnabled}
          onCheckedChange={(digestEnabled) =>
            void saveSettings({ ...settings, digestEnabled })
          }
        />
      </div>

      {(isSaving || error) && (
        <p
          className={cn(
            "text-sm",
            error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {error ?? "Saving..."}
        </p>
      )}

      {settings.digestEnabled && (
        <>
          {/* Frequency */}
          <div>
            <label className="mb-2 block font-medium text-sm">Frequency</label>
            <div className="flex gap-2">
              {frequencyOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() =>
                    void saveSettings({ ...settings, frequency: opt.value })
                  }
                  className={cn(
                    "rounded-lg border px-4 py-2 font-medium text-sm transition-colors",
                    settings.frequency === opt.value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Delivery Channel */}
          <div>
            <label className="mb-2 block font-medium text-sm">Delivery</label>
            <div className="flex gap-2">
              {channelOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() =>
                    void saveSettings({
                      ...settings,
                      deliveryChannel: opt.value,
                    })
                  }
                  className={cn(
                    "rounded-lg border px-4 py-2 font-medium text-sm transition-colors",
                    settings.deliveryChannel === opt.value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
