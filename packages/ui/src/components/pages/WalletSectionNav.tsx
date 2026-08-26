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
 * The wallet root also carries the price surface (#16943): when the home spec
 * demoted the `wallet.balance` resident card, the routed wallet view became the
 * price surface's mandated home (NOTIFICATIONS-WIDGETS-SYSTEM.md §E item 3).
 * `WalletBalanceWidget` renders here on the root tab only — BTC/SOL/ETH by
 * default, top-3 held, 60s visibility-gated refresh, price-only (#10706).
 */

import { useSyncExternalStore } from "react";
import {
  type AppShellPageRegistration,
  getAppShellPageRegistrySnapshot,
  subscribeAppShellPages,
} from "../../app-shell-registry";
import { WalletBalanceWidget } from "../chat/widgets/wallet-balance";
import {
  isSectionPath,
  normalizeSectionPath,
  SectionNav,
  type SectionPathRewrite,
  type SectionTab,
  sectionTabs,
} from "../shared/SectionNav";
import { ViewHeader } from "../shared/ViewHeader";
import { Separator } from "../ui/separator";

const WALLET_SECTION_GROUP = "wallet";
const WALLET_ROOT_PATH = "/wallet";
/** Registration path of the root inventory page (aliased to `/wallet`). */
const WALLET_INVENTORY_PATH = "/inventory";

/** True on the wallet root tab (either alias), where the price surface lives. */
function isWalletRootPath(path: string): boolean {
  const normalized = normalizeSectionPath(path);
  return (
    normalized === WALLET_ROOT_PATH || normalized === WALLET_INVENTORY_PATH
  );
}

/**
 * Canonical-root rewrite for the Wallet section: the inventory page registers
 * under `/inventory` but owns the `/wallet` root tab, so alias both routes.
 */
const walletRewrite: SectionPathRewrite = (
  registration: AppShellPageRegistration,
): SectionTab | null => {
  const registrationPath = normalizeSectionPath(registration.path);
  if (registrationPath === "/inventory") {
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
  return (
    <div className="flex shrink-0 flex-col">
      <ViewHeader title="Wallet" />
      <SectionNav
        group={WALLET_SECTION_GROUP}
        activePath={activePath}
        rewrite={walletRewrite}
        ariaLabel="Wallet sections"
        className="pt-0"
      />
      {isWalletRootPath(activePath) ? (
        <div
          data-testid="wallet-section-price-surface"
          className="mx-auto w-full max-w-md px-4 pb-3"
        >
          <WalletBalanceWidget spanClassName="w-full" />
        </div>
      ) : null}
      <Separator tone="subtle45" />
    </div>
  );
}
