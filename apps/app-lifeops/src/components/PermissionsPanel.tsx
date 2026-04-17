import { Badge, Button } from "@elizaos/app-core";
import {
  Camera,
  Eye,
  Mic,
  Monitor,
  Bell,
  MapPin,
  Heart,
  ShieldCheck,
  ExternalLink,
} from "lucide-react";
import { useMemo } from "react";

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

function statusBadge(status: PermissionStatus) {
  switch (status) {
    case "granted":
      return (
        <Badge variant="secondary" className="text-2xs text-ok">
          Granted
        </Badge>
      );
    case "denied":
      return (
        <Badge variant="outline" className="text-2xs text-danger">
          Not Granted
        </Badge>
      );
    case "unknown":
      return (
        <Badge variant="outline" className="text-2xs text-muted">
          Unknown
        </Badge>
      );
  }
}

function PermissionRow({ entry }: { entry: PermissionEntry }) {
  const handleOpenSettings = () => {
    // On macOS, we can try to open System Settings. On iOS, open Settings app.
    // For now this is a placeholder that the native plugin can hook into.
    if (typeof window !== "undefined") {
      // Desktop apps may expose an openSystemPreferences bridge
      const win = window as Record<string, unknown>;
      if (typeof win.openSystemPreferences === "function") {
        (win.openSystemPreferences as (id: string) => void)(entry.id);
      }
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border/16 bg-bg/40 px-3 py-3">
      <div className="text-muted">{entry.icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-txt">{entry.name}</div>
        <div className="text-xs text-muted">{entry.description}</div>
      </div>
      <div className="flex items-center gap-2">
        {statusBadge(entry.status)}
        {entry.status !== "granted" ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 rounded-lg px-2 text-[11px] font-semibold"
            onClick={handleOpenSettings}
          >
            <ExternalLink className="mr-1 h-3 w-3" />
            Settings
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
    <section className="overflow-hidden rounded-3xl border border-border/16 bg-card/18">
      <div className="px-4 py-4">
        <div className="flex items-center gap-2">
          <Eye className="h-4 w-4 text-muted" />
          <div className="text-sm font-semibold text-txt">Permissions</div>
        </div>
        <div className="mt-1 text-xs text-muted">
          {platform === "macos"
            ? "macOS system permissions needed for full LifeOps functionality."
            : "iOS permissions needed for full LifeOps functionality."}
        </div>
      </div>
      <div className="space-y-2 border-t border-border/12 px-4 pb-4 pt-3">
        {permissions.map((entry) => (
          <PermissionRow key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}
