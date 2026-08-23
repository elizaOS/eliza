/**
 * Maps a permission's string icon key (cursor, mic, camera, calendar, …) to its
 * lucide glyph for permission rows across the settings + streaming surfaces.
 * Unknown keys fall back to the Settings gear.
 */
import {
  Bell,
  Calendar,
  Camera,
  Contact,
  HardDrive,
  HeartPulse,
  Hourglass,
  ListTodo,
  Mic,
  Monitor,
  MousePointer2,
  NotebookTabs,
  Settings,
  ShieldBan,
  Terminal,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";

export function PermissionIcon({ icon }: { icon: string }) {
  const icons: Record<string, ReactNode> = {
    cursor: <MousePointer2 className="size-4" />,
    monitor: <Monitor className="size-4" />,
    mic: <Mic className="size-4" />,
    camera: <Camera className="size-4" />,
    terminal: <Terminal className="size-4" />,
    "shield-ban": <ShieldBan className="size-4" />,
    "list-todo": <ListTodo className="size-4" />,
    calendar: <Calendar className="size-4" />,
    "heart-pulse": <HeartPulse className="size-4" />,
    hourglass: <Hourglass className="size-4" />,
    contact: <Contact className="size-4" />,
    "notebook-tabs": <NotebookTabs className="size-4" />,
    bell: <Bell className="size-4" />,
    "hard-drive": <HardDrive className="size-4" />,
    workflow: <Workflow className="size-4" />,
  };

  return (
    <span className="text-base">
      {icons[icon] ?? <Settings className="size-4" />}
    </span>
  );
}
