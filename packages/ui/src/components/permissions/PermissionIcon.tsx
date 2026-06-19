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
    cursor: <MousePointer2 className="w-4 h-4" />,
    monitor: <Monitor className="w-4 h-4" />,
    mic: <Mic className="w-4 h-4" />,
    camera: <Camera className="w-4 h-4" />,
    terminal: <Terminal className="w-4 h-4" />,
    "shield-ban": <ShieldBan className="w-4 h-4" />,
    "list-todo": <ListTodo className="w-4 h-4" />,
    calendar: <Calendar className="w-4 h-4" />,
    "heart-pulse": <HeartPulse className="w-4 h-4" />,
    hourglass: <Hourglass className="w-4 h-4" />,
    contact: <Contact className="w-4 h-4" />,
    "notebook-tabs": <NotebookTabs className="w-4 h-4" />,
    bell: <Bell className="w-4 h-4" />,
    "hard-drive": <HardDrive className="w-4 h-4" />,
    workflow: <Workflow className="w-4 h-4" />,
  };

  return (
    <span className="text-base">
      {icons[icon] ?? <Settings className="w-4 h-4" />}
    </span>
  );
}
