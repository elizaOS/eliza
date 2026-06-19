import {
  Activity,
  AppWindow,
  BarChart2,
  Bot,
  BrainCircuit,
  CalendarDays,
  Clock,
  Gamepad2,
  Glasses,
  ImageIcon,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  type LucideIcon,
  Mail,
  MessageSquare,
  Monitor,
  Package,
  Phone,
  Shield,
  ShoppingBag,
  Smartphone,
  SquareTerminal,
  Terminal,
  TestTube2,
  TrendingUp,
  Users,
  UsersRound,
  Wallet,
  Zap,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  Activity,
  AppWindow,
  BarChart2,
  Bot,
  BrainCircuit,
  CalendarDays,
  Clock,
  Gamepad2,
  Glasses,
  ImageIcon,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Mail,
  MessageSquare,
  Monitor,
  Package,
  Phone,
  Shield,
  ShoppingBag,
  Smartphone,
  SquareTerminal,
  Terminal,
  TestTube2,
  TrendingUp,
  Users,
  UsersRound,
  Wallet,
  Zap,
};

function isImageIcon(value: string): boolean {
  return (
    value.startsWith("data:image/") ||
    value.startsWith("/") ||
    value.startsWith("http://") ||
    value.startsWith("https://")
  );
}

export function ViewIcon({
  icon,
  className = "h-5 w-5",
}: {
  icon?: string | null;
  label?: string;
  className?: string;
}) {
  if (icon && isImageIcon(icon)) {
    return (
      <img
        src={icon}
        alt=""
        className={className}
        loading="lazy"
        aria-hidden="true"
      />
    );
  }

  const Icon = icon ? ICONS[icon] : undefined;
  if (Icon) {
    return <Icon className={className} aria-hidden="true" />;
  }

  return <LayoutGrid className={className} aria-hidden="true" />;
}
