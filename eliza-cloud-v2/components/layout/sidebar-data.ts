/**
 * Sidebar navigation configuration defining sidebar sections and items.
 * Includes navigation structure with icons, labels, badges, and permission settings.
 */
import { HomeIcon, ImageIcon, LayersIcon } from "@radix-ui/react-icons";
import {
  Server,
  Video,
  UserCog,
  Code,
  Mic,
  Bot,
  Puzzle,
  Grid3x3,
  Shield,
  Wallet,
  Coins,
  Sparkles,
} from "lucide-react";
import type { ComponentType } from "react";
import type { FeatureFlag } from "@/lib/config/feature-flags";

export interface SidebarItem {
  id: string;
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  badge?: string | number;
  isNew?: boolean;
  freeAllowed?: boolean;
  featureFlag?: FeatureFlag;
  adminOnly?: boolean; // Only show for admin users
  comingSoon?: boolean; // Show as disabled with "soon" tag
}

export interface SidebarSection {
  title?: string;
  items: SidebarItem[];
  adminOnly?: boolean; // Only show section for admin users
}

export const sidebarSections: SidebarSection[] = [
  {
    items: [
      {
        id: "dashboard",
        label: "Dashboard",
        href: "/dashboard",
        icon: HomeIcon,
      },
    ],
  },
  {
    title: "Apps",
    items: [
      {
        id: "app-creator",
        label: "App Creator",
        href: "/dashboard/apps/create",
        icon: Sparkles,
        freeAllowed: false,
      },
      {
        id: "my-apps",
        label: "My Apps",
        href: "/dashboard/apps",
        icon: Grid3x3,
        freeAllowed: false,
      },
    ],
  },
  {
    title: "Agents",
    items: [
      {
        id: "my-agents",
        label: "My Agents",
        href: "/dashboard/my-agents",
        icon: Bot,
        freeAllowed: false, // Requires signup
      },
      {
        id: "api-explorer",
        label: "API Explorer",
        href: "/dashboard/api-explorer",
        icon: Code,
        freeAllowed: false, // Requires signup
      },
    ],
  },
  {
    title: "Generation Studio",
    items: [
      {
        id: "image-generation",
        label: "Images",
        href: "/dashboard/image",
        icon: ImageIcon,
        freeAllowed: false, // Requires signup
      },
      {
        id: "video-generation",
        label: "Videos",
        href: "/dashboard/video",
        icon: Video,
        freeAllowed: false, // Requires signup
      },
      {
        id: "voices",
        label: "Voices",
        href: "/dashboard/voices",
        icon: Mic,
        freeAllowed: false,
        featureFlag: "voiceCloning",
      },
      {
        id: "gallery",
        label: "Gallery",
        href: "/dashboard/gallery",
        icon: LayersIcon,
        freeAllowed: false,
        featureFlag: "gallery",
      },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      {
        id: "containers",
        label: "Containers",
        href: "/dashboard/containers",
        icon: Server,
        freeAllowed: false,
        featureFlag: "containers",
      },
      {
        id: "mcps",
        label: "MCPs",
        href: "/dashboard/mcps",
        icon: Puzzle,
        freeAllowed: false,
        featureFlag: "mcp",
      },
    ],
  },
  {
    title: "Monetization",
    items: [
      {
        id: "earnings",
        label: "Earnings",
        href: "/dashboard/earnings",
        icon: Coins,
        freeAllowed: false,
        isNew: true,
      },
      {
        id: "billing",
        label: "Billing",
        href: "/dashboard/billing",
        icon: Wallet,
        freeAllowed: false,
      },
    ],
  },
  {
    title: "Admin",
    adminOnly: true, // Only visible to admin users
    items: [
      {
        id: "admin-moderation",
        label: "Moderation",
        href: "/dashboard/admin",
        icon: Shield,
        freeAllowed: false,
        adminOnly: true,
      },
      {
        id: "admin-redemptions",
        label: "Redemptions",
        href: "/dashboard/admin/redemptions",
        icon: Coins,
        freeAllowed: false,
        adminOnly: true,
      },
    ],
  },
];
