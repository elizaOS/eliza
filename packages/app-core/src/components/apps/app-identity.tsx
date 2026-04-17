import {
  Bot,
  Briefcase,
  Gamepad2,
  Globe2,
  type LucideIcon,
  Sparkles,
  Wallet,
  Wrench,
} from "lucide-react";
import { type CSSProperties, useState } from "react";

export interface AppIdentitySource {
  name: string;
  displayName?: string | null;
  category?: string | null;
  icon?: string | null;
  /**
   * URL to a full-card hero image for this app. Declared by the app
   * itself in `package.json` → `elizaos.app.heroImage` and surfaced via
   * `RegistryAppInfo.heroImage`; falls back to procedural art when absent.
   */
  heroImage?: string | null;
  description?: string | null;
}

const APP_TILE_PALETTES = [
  ["#0ea5e9", "#8b5cf6"],
  ["#10b981", "#14b8a6"],
  ["#f59e0b", "#f97316"],
  ["#ef4444", "#f43f5e"],
  ["#22c55e", "#84cc16"],
  ["#06b6d4", "#3b82f6"],
  ["#a855f7", "#ec4899"],
  ["#64748b", "#0f766e"],
] as const;

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

export function iconImageSource(
  icon: string | null | undefined,
): string | null {
  const value = icon?.trim();
  if (!value) return null;
  if (
    /^(https?:|data:image\/|blob:|file:|capacitor:|electrobun:|app:|\/|\.\/|\.\.\/)/i.test(
      value,
    )
  ) {
    return value;
  }
  return null;
}

function getAppMonogram(app: AppIdentitySource): string {
  const label = (app.displayName ?? app.name)
    .replace(/^@[^/]+\//, "")
    .replace(/^(app|plugin)-/i, "");
  const words = label.split(/[\s._/-]+/).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return (initials || label.slice(0, 2).toUpperCase() || "?").slice(0, 2);
}

function getAppPalette(name: string): readonly [string, string] {
  return APP_TILE_PALETTES[hashString(name) % APP_TILE_PALETTES.length];
}

function getAppCategoryIcon(app: AppIdentitySource): LucideIcon {
  const blob = [
    app.name,
    app.displayName ?? "",
    app.category ?? "",
    app.description ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (/game|play|arcade|quest|adventure|battle|rpg/.test(blob)) {
    return Gamepad2;
  }
  if (/companion|chat|social|friend|community|message|dm/.test(blob)) {
    return Bot;
  }
  if (/finance|wallet|shop|commerce|trade|market|billing|invoice/.test(blob)) {
    return Wallet;
  }
  if (
    /utility|debug|runtime|viewer|plugin|memory|log|database|settings/.test(
      blob,
    )
  ) {
    return Wrench;
  }
  if (/world|browser|web|network|global|platform/.test(blob)) {
    return Globe2;
  }
  if (/ops|business|team|work|project|task|calendar|life/.test(blob)) {
    return Briefcase;
  }
  return Sparkles;
}

export function AppIdentityTile({
  app,
  active = false,
  className = "",
  size = "md",
}: {
  app: AppIdentitySource;
  active?: boolean;
  className?: string;
  size?: "sm" | "md";
}) {
  const palette = getAppPalette(app.name);
  const iconSrc = iconImageSource(app.icon);
  const Icon = getAppCategoryIcon(app);
  const monogram = getAppMonogram(app);
  const outerSize =
    size === "sm" ? "h-12 w-12 rounded-2xl" : "h-14 w-14 rounded-[1.15rem]";
  const iconSize = size === "sm" ? "h-5 w-5" : "h-6 w-6";
  const monoSize = size === "sm" ? "text-[0.64rem]" : "text-[0.68rem]";
  const badgeSize = size === "sm" ? "text-[0.56rem]" : "text-[0.58rem]";

  return (
    <div
      className={`relative shrink-0 overflow-hidden border border-white/10 shadow-sm ring-1 ring-black/5 ${outerSize} ${className}`}
      style={
        {
          backgroundImage: `linear-gradient(135deg, ${palette[0]} 0%, ${palette[1]} 100%)`,
        } as CSSProperties
      }
      aria-hidden
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_18%,rgba(255,255,255,0.32),transparent_30%),radial-gradient(circle_at_82%_20%,rgba(255,255,255,0.18),transparent_26%),radial-gradient(circle_at_50%_100%,rgba(0,0,0,0.16),transparent_35%)]" />
      {iconSrc ? (
        <>
          <img
            src={iconSrc}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-black/10" />
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-white">
          <Icon className={iconSize} strokeWidth={2.15} />
          <span
            className={`inline-flex items-center rounded-full border border-white/20 bg-white/12 px-1.5 py-0.5 font-semibold uppercase tracking-[0.18em] text-white ${monoSize}`}
          >
            {monogram}
          </span>
        </div>
      )}
      {active ? (
        <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full border border-card bg-ok shadow-sm" />
      ) : null}
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/12 to-transparent" />
      {iconSrc ? (
        <div
          className={`absolute left-1.5 top-1.5 inline-flex items-center rounded-full border border-white/20 bg-black/10 px-1.5 py-0.5 font-semibold uppercase tracking-[0.18em] text-white ${badgeSize}`}
        >
          {monogram}
        </div>
      ) : null}
    </div>
  );
}

interface HeroBlob {
  cx: number;
  cy: number;
  r: number;
  opacity: number;
}

function getHeroBlobs(seed: number): HeroBlob[] {
  const pick = (shift: number, mod: number) => (seed >> shift) % mod;
  return [
    {
      cx: 18 + pick(1, 32),
      cy: 22 + pick(3, 28),
      r: 34 + pick(5, 22),
      opacity: 0.32,
    },
    {
      cx: 72 - pick(7, 26),
      cy: 68 - pick(9, 32),
      r: 38 + pick(11, 26),
      opacity: 0.24,
    },
    {
      cx: 45 + pick(13, 24),
      cy: 40 + pick(15, 24),
      r: 24 + pick(17, 18),
      opacity: 0.18,
    },
  ];
}

/**
 * Full-card hero visual for an app. Prefers an app-declared hero image
 * (see `AppIdentitySource.heroImage`, sourced from the app's own
 * package.json and served via `/api/apps/hero/<slug>`), then a
 * caller-provided icon URL, then a procedurally generated gradient
 * scene — seeded from the app name so each app looks distinct.
 */
export function AppHero({
  app,
  className = "",
}: {
  app: AppIdentitySource;
  className?: string;
}) {
  const palette = getAppPalette(app.name);
  const iconSrc = iconImageSource(app.icon);
  const heroSrc = app.heroImage?.trim() || null;
  const Icon = getAppCategoryIcon(app);
  const monogram = getAppMonogram(app);
  const blobs = getHeroBlobs(hashString(app.name));
  const iconRotation = hashString(app.name) % 24;

  const primarySrc = heroSrc ?? iconSrc ?? null;
  const [imageFailed, setImageFailed] = useState(false);
  const useImage = Boolean(primarySrc) && !imageFailed;

  return (
    <div
      className={`relative w-full overflow-hidden ${className}`}
      style={
        {
          backgroundImage: `linear-gradient(135deg, ${palette[0]} 0%, ${palette[1]} 100%)`,
        } as CSSProperties
      }
      aria-hidden
    >
      {useImage && primarySrc ? (
        <img
          src={primarySrc}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <>
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden
          >
            <title>Hero backdrop</title>
            {blobs.map((blob) => (
              <circle
                key={`${blob.cx}-${blob.cy}-${blob.r}`}
                cx={blob.cx}
                cy={blob.cy}
                r={blob.r}
                fill="white"
                opacity={blob.opacity}
                style={{ mixBlendMode: "soft-light" }}
              />
            ))}
          </svg>
          <div
            className="absolute inset-0 opacity-[0.14]"
            style={{
              backgroundImage:
                "radial-gradient(circle, rgba(255,255,255,0.85) 1px, transparent 1px)",
              backgroundSize: "14px 14px",
            }}
          />
          <div
            className="pointer-events-none absolute -right-6 -bottom-8 h-[68%] w-[68%] text-white/[0.22]"
            style={{ transform: `rotate(${iconRotation - 12}deg)` }}
          >
            <Icon className="h-full w-full" strokeWidth={1.25} />
          </div>
        </>
      )}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-20%,rgba(255,255,255,0.22),transparent_55%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />
      <div className="absolute left-3 top-3 inline-flex items-center rounded-full border border-white/25 bg-white/15 px-2 py-0.5 text-[0.58rem] font-semibold uppercase tracking-[0.22em] text-white backdrop-blur-sm">
        {monogram}
      </div>
    </div>
  );
}
