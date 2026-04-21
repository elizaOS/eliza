import { Button } from "@elizaos/app-core";
import {
  Bell,
  Camera,
  Heart,
  MapPin,
  Mic,
  Monitor,
  ShieldCheck,
} from "lucide-react";
import { useMemo } from "react";

declare global {
  interface Window {
    openSystemPreferences?: (id: string) => void;
  }
}

type PermissionStatus = "granted" | "denied" | "unknown";

interface PermissionEntry {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  status: PermissionStatus;
}

function detectPlatform(): "macos" | "ios" | "other" {
  if (typeof navigator === "undefined") {
    return "other";
  }
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) {
    return "ios";
  }
  if (/Macintosh/.test(ua)) {
    return "macos";
  }
  return "other";
}

const ICON_CLASS = "h-4 w-4 shrink-0";

function macosPermissions(): PermissionEntry[] {
  return [
    {
      id: "accessibility",
      name: "Accessibility",
      description: "Computer use and automation",
      icon: <ShieldCheck className={ICON_CLASS} />,
      status: "unknown",
    },
    {
      id: "screen-recording",
      name: "Screen Recording",
      description: "Screenshots for context",
      icon: <Monitor className={ICON_CLASS} />,
      status: "unknown",
    },
    {
      id: "notifications",
      name: "Notifications",
      description: "Reminders and alerts",
      icon: <Bell className={ICON_CLASS} />,
      status: "unknown",
    },
    {
      id: "microphone",
      name: "Microphone",
      description: "Voice commands",
      icon: <Mic className={ICON_CLASS} />,
      status: "unknown",
    },
  ];
}

function iosPermissions(): PermissionEntry[] {
  return [
    {
      id: "camera",
      name: "Camera",
      description: "Photo and video capture",
      icon: <Camera className={ICON_CLASS} />,
      status: "unknown",
    },
    {
      id: "microphone",
      name: "Microphone",
      description: "Voice commands",
      icon: <Mic className={ICON_CLASS} />,
      status: "unknown",
    },
    {
      id: "location",
      name: "Location",
      description: "Location-aware reminders",
      icon: <MapPin className={ICON_CLASS} />,
      status: "unknown",
    },
    {
      id: "healthkit",
      name: "HealthKit",
      description: "Health and fitness data",
      icon: <Heart className={ICON_CLASS} />,
      status: "unknown",
    },
    {
      id: "notifications",
      name: "Notifications",
      description: "Reminders and alerts",
      icon: <Bell className={ICON_CLASS} />,
      status: "unknown",
    },
  ];
}

function PermissionRow({ entry }: { entry: PermissionEntry }) {
  const canOpenSystemPreferences =
    typeof window !== "undefined" &&
    typeof window.openSystemPreferences === "function";

  const handleGrant = () => {
    if (
      typeof window !== "undefined" &&
      typeof window.openSystemPreferences === "function"
    ) {
      window.openSystemPreferences(entry.id);
    }
  };

  const dotColor =
    entry.status === "granted"
      ? "bg-emerald-500"
      : entry.status === "denied"
        ? "bg-red-500"
        : "bg-muted/40";

  const statusText =
    entry.status === "granted"
      ? "Enabled"
      : entry.status === "denied"
        ? "Denied"
        : "Check in System Settings";
  const buttonLabel = entry.status === "unknown" ? "Open Settings" : "Enable";

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex items-center gap-3">
        <div className="text-muted">{entry.icon}</div>
        <div>
          <div className="text-sm font-medium text-txt">{entry.name}</div>
          <div className="text-xs text-muted">{entry.description}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
        <span className="text-xs text-muted">{statusText}</span>
        {entry.status !== "granted" && canOpenSystemPreferences ? (
          <Button
            size="sm"
            variant="default"
            className="h-7 rounded-lg px-3 text-[11px] font-semibold"
            onClick={handleGrant}
          >
            {buttonLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function PermissionsPanel() {
  const platform = useMemo(() => detectPlatform(), []);
  const permissions = useMemo(() => {
    switch (platform) {
      case "macos":
        return macosPermissions();
      case "ios":
        return iosPermissions();
      default:
        return [];
    }
  }, [platform]);

  if (permissions.length === 0) {
    return null;
  }

  return (
    <section className="space-y-1">
      <div className="pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
        Permissions
      </div>
      <div className="space-y-1">
        {permissions.map((entry) => (
          <PermissionRow key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}
