import {
  Camera,
  Mic,
  Monitor,
  MousePointer2,
  Settings,
  ShieldBan,
  Terminal,
} from "lucide-react";
import type { ReactNode } from "react";

export function PermissionIcon({ icon }: { icon: string }) {
  const icons: Record<string, ReactNode> = {
    cursor: <MousePointer2 className="w-4 h-4" />,
    monitor: <Monitor className="w-4 h-4" />,
    mic: <Mic className="w-4 h-4" />,
    camera: <Camera className="w-4 h-4" />,
    terminal: <Terminal className="w-4 h-4" />,
    "shield-ban": <ShieldBan className="w-4 h-4" />,
  };

  return (
    <span className="text-base">
      {icons[icon] ?? <Settings className="w-4 h-4" />}
    </span>
  );
}
