/**
 * Console surface catalog shared by the sidebar and overview cards. The
 * advertised control-plane routes are intentionally narrower than the complete
 * router: deep-linkable specialist surfaces stay registered, but only the core
 * agent, app, billing, key, account, and organization paths are promoted here.
 */

import {
  Bot,
  Building2,
  CreditCard,
  Home,
  KeyRound,
  type LucideIcon,
  User,
} from "lucide-react";

export interface ConsoleSurface {
  id: string;
  href: string;
  icon: LucideIcon;
  /** Sidebar label (the nav renders plain labels). */
  label: string;
  /** Overview-card copy (i18n key + fallback). */
  titleKey: string;
  titleDefault: string;
  descKey: string;
  descDefault: string;
}

/** Overview is nav-only: it IS the page the cards live on. */
export const CONSOLE_OVERVIEW_NAV_ITEM = {
  id: "overview",
  label: "Overview",
  href: "/dashboard",
  icon: Home,
} as const;

export const CONSOLE_SURFACES: ReadonlyArray<ConsoleSurface> = [
  {
    id: "agents",
    href: "/dashboard/agents",
    icon: Bot,
    label: "Agents",
    titleKey: "cloud.home.agents",
    titleDefault: "Agents",
    descKey: "cloud.home.agentsDesc",
    descDefault: "Hosted agents: create, wake, sleep, logs.",
  },
  {
    id: "billing",
    href: "/dashboard/billing",
    icon: CreditCard,
    label: "Billing",
    titleKey: "cloud.home.billing",
    titleDefault: "Billing",
    descKey: "cloud.home.billingDesc",
    descDefault: "Add funds, payment methods, invoices.",
  },
  {
    id: "api-keys",
    href: "/dashboard/api-keys",
    icon: KeyRound,
    label: "API Keys",
    titleKey: "cloud.home.apiKeys",
    titleDefault: "API Keys",
    descKey: "cloud.home.apiKeysDesc",
    descDefault: "Create and revoke inference API keys.",
  },
  {
    id: "account",
    href: "/dashboard/account",
    icon: User,
    label: "Account",
    titleKey: "cloud.home.account",
    titleDefault: "Account",
    descKey: "cloud.home.accountDesc",
    descDefault: "Profile, email, identity, and security.",
  },
  {
    id: "organization",
    href: "/dashboard/organization",
    icon: Building2,
    label: "Organization",
    titleKey: "cloud.home.organization",
    titleDefault: "Organization",
    descKey: "cloud.home.organizationDesc",
    descDefault: "Members, credentials, and invites.",
  },
];
