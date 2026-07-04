/**
 * Resolves a view's icon to a rendered glyph for launcher tiles and nav rows.
 * An `icon` that is a data-URI / URL / absolute path renders as an `<img>`; a
 * named lucide key resolves from the ICONS map; anything unknown (or absent)
 * falls back to a keyword match against the view's label/id (KEYWORD_ICONS,
 * first-match-wins) so every view still gets a distinct, meaningful glyph
 * rather than a generic grid fallback.
 */
import {
  Activity,
  AppWindow,
  BarChart2,
  Bot,
  BrainCircuit,
  CalendarDays,
  Clock,
  Database,
  FileText,
  Focus,
  FolderClosed,
  Gamepad2,
  Glasses,
  Globe,
  Heart,
  ImageIcon,
  Inbox,
  KeyRound,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  ListTodo,
  type LucideIcon,
  Mail,
  MessageSquare,
  Mic,
  Monitor,
  Network,
  Package,
  Phone,
  Plug,
  Radio,
  Rss,
  ScrollText,
  Settings,
  Shield,
  ShoppingBag,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Target,
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
  Database,
  FileText,
  Focus,
  FolderClosed,
  Gamepad2,
  Glasses,
  Globe,
  Heart,
  ImageIcon,
  Inbox,
  KeyRound,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  ListTodo,
  Mail,
  MessageSquare,
  Mic,
  Monitor,
  Network,
  Package,
  Phone,
  Plug,
  Radio,
  Rss,
  ScrollText,
  Settings,
  Shield,
  ShoppingBag,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Target,
  Terminal,
  TestTube2,
  TrendingUp,
  Users,
  UsersRound,
  Wallet,
  Zap,
};

// Keyword → icon, so a view with no (or an unrecognized) icon name still gets a
// distinct, meaningful glyph derived from its label/id instead of the generic
// grid fallback. First match wins; order matters.
const KEYWORD_ICONS: Array<[RegExp, LucideIcon]> = [
  [/setting|preference|config/, Settings],
  [/calendar|schedule|agenda/, CalendarDays],
  [/wallet/, Wallet],
  [/financ|budget|spend|money|portfolio/, TrendingUp],
  [/health|fitness|wellness|sleep/, Heart],
  [/todo|checklist|\btask/, ListTodo],
  [/\bfile|folder/, FolderClosed],
  [/document|transcript|\bdoc\b/, FileText],
  [/browser|\bweb\b|internet/, Globe],
  [/skill|capabilit/, Sparkles],
  [/voice|microphone|\bmic\b|speech|audio/, Mic],
  [/stream|broadcast|live\b/, Radio],
  [/\blog|console|output/, ScrollText],
  [/plugin|extension|integration/, Plug],
  [/goal|objective|target/, Target],
  [/focus|blocker|deep work|distraction/, Focus],
  [/inbox/, Inbox],
  [/mail|email/, Mail],
  [/message|sms|imessage|whatsapp|telegram/, MessageSquare],
  [/contact|address book/, UsersRound],
  [/relationship|network|graph|connection/, Network],
  [/phone|call|dial/, Phone],
  [/companion|avatar|persona/, Bot],
  [/life ?ops|daily brief|assistant|dashboard/, LayoutDashboard],
  [/polymarket|hyperliquid|trade|trading|market|perp|swap/, TrendingUp],
  [/shop|store|commerce|product|cart/, ShoppingBag],
  [/steward/, Shield],
  [/delegat|signer|\bkey\b|credential/, KeyRound],
  [/screen ?share|display|monitor/, Monitor],
  [/fine ?tun|training|optimiz/, BrainCircuit],
  [/model|test/, TestTube2],
  [/vector|database|memory|embedding|knowledge/, Database],
  [/trajector|\blog/, Activity],
  [/feed|social|alpha/, Rss],
  [/glass|facewear|smart ?glass|\bxr\b|spatial|vr\b/, Glasses],
  [/arcade|\bgame/, Gamepad2],
  [/coordinat|orchestrat|builder|maker|coding|workflow/, Bot],
  [/plugin|catalog|apps?\b/, LayoutGrid],
];

function guessIconFromText(label?: string, id?: string): LucideIcon {
  const hay = `${label ?? ""} ${id ?? ""}`.toLowerCase();
  for (const [re, Icon] of KEYWORD_ICONS) {
    if (re.test(hay)) return Icon;
  }
  return LayoutGrid;
}

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
  label,
  id,
  className = "h-5 w-5",
}: {
  icon?: string | null;
  label?: string;
  id?: string;
  className?: string;
}) {
  if (icon && isImageIcon(icon)) {
    return (
      <img
        src={icon}
        alt=""
        className={className}
        loading="lazy"
        decoding="async"
        aria-hidden="true"
      />
    );
  }

  const Icon = (icon ? ICONS[icon] : undefined) ?? guessIconFromText(label, id);
  return <Icon className={className} aria-hidden="true" />;
}
