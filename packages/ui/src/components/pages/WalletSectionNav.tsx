/**
 * Wallet section navigation renders sub-tabs from app-shell pages that declare
 * the wallet group. The wallet inventory page owns the root `/wallet` tab while
 * plugin pages join or leave the section through their own registration data.
 *
 * As of #13586 this is a thin Wallet-specific wrapper over the generalized
 * `SectionNav` primitive: it supplies the `wallet` group + the canonical-root
 * rewrite (inventory → `/wallet`), and lands the doctrine geometry — a centered
 * "Wallet" `ViewHeader` (icon-only launcher back) ABOVE the secondary tab strip,
 * rather than a tabs-only header with no title.
 *
 * Balance, network, and asset state live in the canonical wallet body. Keeping
 * this wrapper navigation-only avoids a second balance request and prevents a
 * late-loading header card from shifting the routed view.
 */

import { useSyncExternalStore } from "react";
import {
  type AppShellPageRegistration,
  getAppShellPageRegistrySnapshot,
  subscribeAppShellPages,
} from "../../app-shell-registry";
import { cn } from "../../lib/utils";
import { getFrontendPlatform } from "../../platform/platform-guards";
import {
  isSectionPath,
  normalizeSectionPath,
  SectionNav,
  type SectionPathRewrite,
  type SectionTab,
  sectionTabs,
} from "../shared/SectionNav";
import { ViewHeader } from "../shared/ViewHeader";
import { Card } from "../ui/card";

const WALLET_SECTION_GROUP = "wallet";
const WALLET_ROOT_PATH = "/wallet";
/** Registration path of the root inventory page (aliased to `/wallet`). */
const WALLET_INVENTORY_PATH = "/inventory";

/**
 * Canonical-root rewrite for the Wallet section: the inventory page registers
 * under `/inventory` but owns the `/wallet` root tab, so alias both routes.
 */
const walletRewrite: SectionPathRewrite = (
  registration: AppShellPageRegistration,
): SectionTab | null => {
  const registrationPath = normalizeSectionPath(registration.path);
  if (registrationPath === WALLET_INVENTORY_PATH) {
    return {
      id: registration.id,
      label: registration.label,
      path: WALLET_ROOT_PATH,
      aliases: [registrationPath],
    };
  }
  return null;
};

/** The Wallet section tabs, sorted and path-normalized. */
export function walletSectionTabs(): SectionTab[] {
  return sectionTabs(WALLET_SECTION_GROUP, walletRewrite);
}

/** True when a route belongs to the Wallet section (wallet + its sub-views). */
export function isWalletSectionPath(path: string): boolean {
  return isSectionPath(WALLET_SECTION_GROUP, path, walletRewrite);
}

/**
 * The Wallet family header: a centered "Wallet" title with the icon-only
 * launcher back (doctrine top bar) ABOVE the secondary section-tab strip. The
 * strip self-hides when the section has a single member (`SectionNav` returns
 * null), leaving just the header.
 */
export function WalletSectionNav({
  activePath,
}: {
  activePath: string;
}): React.JSX.Element {
  useSyncExternalStore(
    subscribeAppShellPages,
    getAppShellPageRegistrySnapshot,
    getAppShellPageRegistrySnapshot,
  );
  const frontendPlatform = getFrontendPlatform();
  const isNativeWallet =
    frontendPlatform === "ios" || frontendPlatform === "android";
  return (
    <Card asChild variant="bottomDivider">
      <div className="flex shrink-0 flex-col">
        <div
          data-testid="wallet-section-header-inset"
          className={cn(
            isNativeWallet &&
              "pt-[max(calc(var(--safe-area-top,0px)-2rem),0.75rem)]",
          )}
        >
          <ViewHeader title="Wallet" />
        </div>
        <SectionNav
          group={WALLET_SECTION_GROUP}
          activePath={activePath}
          rewrite={walletRewrite}
          ariaLabel="Wallet sections"
          className="pt-0"
        />
      </div>
    </Card>
  );
}
