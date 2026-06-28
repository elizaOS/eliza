import { AlertTriangle, Check, Plug } from "lucide-react";
import { useEffect, useState } from "react";
import { client } from "../../../api";
import { cn } from "../../../lib/utils";
import type { WidgetProps } from "../../../widgets/types";
import { useWidgetNavigation } from "./home-widget-card";

/**
 * Connectors status strip (#9143). A full-width strip of per-provider chips for
 * a curated connector set. Each provider renders one of:
 *   - connected: handle/label + check,
 *   - error / needs-reauth: a warn chip,
 *   - not connected: a tappable "Connect <provider>" chip that opens the
 *     connectors settings view.
 *
 * Always renders (never null) so a fresh device shows connect prompts rather
 * than a blank slot. Naked per the home redesign: white text + a soft shadow on
 * the ambient orange field, no background card / border; chips are faint neutral
 * pills that wash brighter on hover.
 */

// Curated providers shown in the strip, in display order.
const CURATED_PROVIDERS = ["google", "discord", "telegram"] as const;
type CuratedProvider = (typeof CURATED_PROVIDERS)[number];

const PROVIDER_LABELS: Record<CuratedProvider, string> = {
  google: "Google",
  discord: "Discord",
  telegram: "Telegram",
};

const CONNECTORS_SETTINGS_VIEW = "/settings/connectors";

type ChipState =
  | { kind: "connected"; label: string }
  | { kind: "warn"; label: string }
  | { kind: "connect" };

interface ProviderChip {
  provider: CuratedProvider;
  name: string;
  state: ChipState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Resolve a single provider's chip state from its account list. The accounts
 * response is untrusted network input, so it's narrowed defensively here:
 *   - any account with status "connected" → connected (its handle/label),
 *   - else any account with status "error" / "needs-reauth" → warn,
 *   - else → connect affordance.
 */
function resolveChipState(
  accounts: { status?: string; handle?: string | null; label?: string }[],
): ChipState {
  const connected = accounts.find((account) => account.status === "connected");
  if (connected) {
    const text =
      (typeof connected.handle === "string" && connected.handle) ||
      (typeof connected.label === "string" && connected.label) ||
      "Connected";
    return { kind: "connected", label: text };
  }
  const broken = accounts.find(
    (account) =>
      account.status === "error" || account.status === "needs-reauth",
  );
  if (broken) {
    const text =
      (typeof broken.label === "string" && broken.label) || "Reconnect";
    return { kind: "warn", label: text };
  }
  return { kind: "connect" };
}

/** Curated providers that the connectors config reports as available. */
function availableCuratedProviders(
  connectors: Record<string, unknown>,
): CuratedProvider[] {
  return CURATED_PROVIDERS.filter((provider) => provider in connectors);
}

function ConnectorsStatusWidget(props: Partial<WidgetProps>) {
  const spanClassName = props.spanClassName ?? "col-span-2 row-span-1";
  const nav = useWidgetNavigation();
  const [chips, setChips] = useState<ProviderChip[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      let providers: CuratedProvider[] = [...CURATED_PROVIDERS];
      try {
        const { connectors } = await client.getConnectors();
        if (isRecord(connectors)) {
          const available = availableCuratedProviders(connectors);
          if (available.length > 0) providers = available;
        }
      } catch {
        // Connector config unavailable — fall back to the full curated set so
        // the strip still offers connect prompts rather than collapsing.
      }

      const resolved = await Promise.all(
        providers.map(async (provider): Promise<ProviderChip> => {
          const base: Omit<ProviderChip, "state"> = {
            provider,
            name: PROVIDER_LABELS[provider],
          };
          try {
            const { accounts } = await client.listConnectorAccounts(provider);
            return {
              ...base,
              state: resolveChipState(Array.isArray(accounts) ? accounts : []),
            };
          } catch {
            // Per-provider failure → warn chip, not a silent drop.
            return { ...base, state: { kind: "warn", label: "Unavailable" } };
          }
        }),
      );

      if (!cancelled) setChips(resolved);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const openConnectors = () =>
    nav.openView(CONNECTORS_SETTINGS_VIEW, "settings");

  return (
    <div
      data-testid="chat-widget-connectors-status"
      className={cn(
        spanClassName,
        "flex flex-wrap items-center gap-2 px-1 py-1 text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.38)]",
      )}
    >
      {chips == null ? (
        <span
          data-testid="connectors-status-loading"
          className="text-xs text-white/70"
        >
          Loading connectors…
        </span>
      ) : (
        chips.map((chip) => (
          <ProviderChipView
            key={chip.provider}
            chip={chip}
            onConnect={openConnectors}
          />
        ))
      )}
    </div>
  );
}

function ProviderChipView({
  chip,
  onConnect,
}: {
  chip: ProviderChip;
  onConnect: () => void;
}) {
  if (chip.state.kind === "connected") {
    const label = chip.state.label;
    return (
      <button
        type="button"
        data-testid={`connectors-chip-${chip.provider}`}
        data-state="connected"
        aria-label={`${chip.name} connected as ${label}. Open connectors settings.`}
        onClick={onConnect}
        className={cn(
          "group inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
          "bg-white/10 text-xs font-medium text-white transition-colors hover:bg-white/16",
        )}
      >
        <Check aria-hidden className="h-3.5 w-3.5 text-white" />
        <span className="max-w-[8rem] truncate">{chip.name}</span>
      </button>
    );
  }

  if (chip.state.kind === "warn") {
    const label = chip.state.label;
    return (
      <button
        type="button"
        data-testid={`connectors-chip-${chip.provider}`}
        data-state="warn"
        aria-label={`${chip.name} needs attention: ${label}. Open connectors settings.`}
        onClick={onConnect}
        className={cn(
          "group inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
          // Neutral white pill (legible over the orange field) with an amber
          // alert glyph carrying the "needs attention" signal — an orange-on-
          // orange warn pill blended into the background.
          "bg-white/10 text-xs font-medium text-white transition-colors hover:bg-white/16",
        )}
      >
        <AlertTriangle aria-hidden className="h-3.5 w-3.5 text-amber-300" />
        <span className="max-w-[8rem] truncate">{chip.name}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid={`connectors-chip-${chip.provider}`}
      data-state="connect"
      aria-label={`Connect ${chip.name}. Open connectors settings.`}
      onClick={onConnect}
      className={cn(
        "group inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
        "bg-white/6 text-xs font-medium text-white/80 transition-colors hover:bg-white/14 hover:text-white",
      )}
    >
      <Plug aria-hidden className="h-3.5 w-3.5" />
      <span className="max-w-[8rem] truncate">Connect {chip.name}</span>
    </button>
  );
}

export { ConnectorsStatusWidget };
