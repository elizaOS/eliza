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
  Bird,
  Bot,
  Boxes,
  Brain,
  BrainCircuit,
  CalendarDays,
  CircleDollarSign,
  ClipboardList,
  Clock,
  Clock3,
  CreditCard,
  Database,
  Files,
  FileText,
  Focus,
  FolderClosed,
  Gamepad2,
  Glasses,
  Globe,
  GraduationCap,
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
  ScatterChart,
  ScrollText,
  Settings,
  Shield,
  ShoppingBag,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  SquareTerminal,
  StickyNote,
  Target,
  Terminal,
  TestTube2,
  TrendingUp,
  UserRound,
  Users,
  UsersRound,
  Wallet,
  Wifi,
  Zap,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  Activity,
  AppWindow,
  BarChart2,
  Bot,
  Boxes,
  Brain,
  BrainCircuit,
  CalendarDays,
  CircleDollarSign,
  Clock,
  Clock3,
  CreditCard,
  Database,
  FileText,
  Files,
  Focus,
  FolderClosed,
  Gamepad2,
  Glasses,
  Globe,
  GraduationCap,
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
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  SquareTerminal,
  StickyNote,
  Target,
  Terminal,
  TestTube2,
  TrendingUp,
  UserRound,
  Users,
  UsersRound,
  Wallet,
  Zap,
};

// Keyword → icon, so a view with no (or an unrecognized) icon name still gets a
// distinct, meaningful glyph derived from its label/id instead of the generic
// grid fallback. First match wins; order matters.
const KEYWORD_ICONS: Array<[RegExp, LucideIcon]> = [
  [/@elizaos\/plugin-native-settings|device settings/, SlidersHorizontal],
  [/@elizaos\/plugin-wallet-ui|wallet ui/, CreditCard],
  [/@elizaos\/plugin-documents|\bdocuments\b/, Files],
  [/setting|preference|config/, Settings],
  [/calendar|schedule|agenda/, CalendarDays],
  [/\bnotes?\b|sticky ?note/, StickyNote],
  [/wallet/, Wallet],
  [/polymarket/, BarChart2],
  [/financ|budget|spend|money|portfolio/, CircleDollarSign],
  [/health|fitness|wellness|sleep/, Heart],
  [/task coordinator/, SquareTerminal],
  [/todo|checklist|\btask/, ListTodo],
  [/\bfile|folder/, FolderClosed],
  [/document|transcript|\bdoc\b/, FileText],
  [/vector browser/, ScatterChart],
  [/browser|\bweb\b|internet/, Globe],
  [/skill|capabilit/, Sparkles],
  [/voice|microphone|\bmic\b|speech|audio/, Mic],
  [/stream|broadcast|live\b/, Radio],
  [/trajectory logger/, Activity],
  [/\blog|console|output/, ScrollText],
  [/goal|objective|target/, Target],
  [/focus|blocker|deep work|distraction/, Focus],
  [/inbox/, Inbox],
  [/mail|email/, Mail],
  [/message|sms|imessage|whatsapp|telegram/, MessageSquare],
  [/contact|address book/, UsersRound],
  [/relationship|network|graph|connection/, Network],
  [/phone|call|dial/, Phone],
  [/personal assistant/, LayoutDashboard],
  [/companion|avatar|persona/, Bot],
  [/character|profile|identity/, UserRound],
  [/life ?ops|daily brief|assistant|dashboard/, LayoutDashboard],
  [/polymarket|hyperliquid|trade|trading|market|perp|swap/, TrendingUp],
  [/shop|store|commerce|product|cart/, ShoppingBag],
  [/steward/, Shield],
  [/delegat|signer|\bkey\b|credential/, KeyRound],
  [/screen ?share|display|monitor/, Monitor],
  [/fine ?tun|training|optimiz/, BrainCircuit],
  [/\bmemories\b|recollection/, Brain],
  [/model|test/, TestTube2],
  [/vector|database|memory|embedding|knowledge/, Database],
  [/trajector|\blog/, Activity],
  [/birdclaw/, Bird],
  [/\bforms?\b|questionnaire|survey/, ClipboardList],
  [/wi-?fi|wireless/, Wifi],
  [/feed|social|alpha/, Rss],
  [/glass|\bxr\b|spatial|vr\b/, Glasses],
  [/arcade|\bgame/, Gamepad2],
  [/coordinat|orchestrat|builder|maker|coding|workflow/, Bot],
  [/my apps|app library|installed apps/, Boxes],
  [/plugin|extension|integration/, Plug],
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
  className = "size-5",
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
