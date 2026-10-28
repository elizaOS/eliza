/**
 * Home of the mobile shell: host notices, a row of agenda and attention
 * cards, and the app grid with its All apps entry. Cards and notices come
 * from their owning features; the product theme supplies every color.
 */
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

export interface MobileHomeTile {
  key: string;
  label: string;
  /** Accessible name when it differs from the label. */
  ariaLabel?: string;
  /** Platform icon image of an installed app. */
  image?: string;
  /** Single-color glyph drawn with the label color. */
  glyphUrl?: string;
  badge?: boolean;
  onOpen: () => void;
}

/** Element props a host adds to a Home part, such as its own test hooks. */
export type MobileShellPartProps = HTMLAttributes<HTMLElement> & {
  [attribute: `data-${string}`]: string | boolean | undefined;
};

export interface MobileHomeScreenProps extends MobileShellPartProps {
  tiles: readonly MobileHomeTile[];
  /** Notices and system controls shown above the cards. */
  header?: ReactNode;
  /** One child per card; the row scrolls sideways. */
  cards?: ReactNode;
  /** Opens All apps; omit when the platform has no app inventory. */
  onOpenAllApps?: () => void;
  allAppsGlyphUrl?: string;
  /** Covered by another layer: out of focus order and the accessibility tree. */
  covered?: boolean;
  layoutProps?: MobileShellPartProps;
  cardsProps?: MobileShellPartProps;
  gridProps?: MobileShellPartProps;
  clearanceProps?: MobileShellPartProps;
}

const MOBILE_HOME_CSS = `
[data-mobile-shell-home]{position:absolute;inset:0;box-sizing:border-box;overflow-x:hidden;overflow-y:auto;background:var(--mobile-shell-home-background,var(--bg));color:var(--text)}
[data-mobile-shell-home-layout]{min-height:100%;display:flex;flex-direction:column;box-sizing:border-box;padding:20px 0 var(--mobile-shell-composer-clearance,108px)}
[data-mobile-shell-cards]{display:flex;flex-shrink:0;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;padding:0 24px;scroll-padding-left:24px;touch-action:pan-x;scrollbar-width:none}
[data-mobile-shell-cards]::-webkit-scrollbar{display:none}
[data-mobile-shell-home-spacer]{flex-grow:1;min-height:28px}
[data-mobile-shell-home-spacer="end"]{min-height:16px}
[data-mobile-shell-apps]{display:grid;grid-template-columns:repeat(auto-fill,minmax(max(calc((100% - (var(--mobile-shell-grid-columns,4) - 1) * var(--mobile-shell-grid-gap,0px)) / var(--mobile-shell-grid-columns,4) - .5px),calc(var(--mobile-shell-grid-min,62px) * var(--mobile-shell-text-scale,1))),1fr));row-gap:24px;padding:0 16px}
[data-mobile-shell-tile]{display:flex;flex-direction:column;align-items:center;gap:8px;min-width:0;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer}
[data-mobile-shell-tile-face]{position:relative;display:flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:var(--mobile-shell-tile-radius,22px);background:var(--surface)}
[data-mobile-shell-tile]:active [data-mobile-shell-tile-face]{background:var(--bg-hover)}
[data-mobile-shell-tile-face]>img{width:44px;height:44px;border-radius:14px}
[data-mobile-shell-tile-badge]{position:absolute;top:12px;right:12px;width:8px;height:8px;border-radius:4px;background:var(--accent)}
[data-mobile-shell-tile-label]{max-width:100%;font-size:12px;color:var(--muted);text-align:center;overflow-wrap:anywhere}
[data-mobile-shell-home-clearance]{height:0;pointer-events:none}
`;

function glyph(url: string): CSSProperties {
  const mask = `url("${url}") center / contain no-repeat`;
  return {
    display: "block",
    width: 30,
    height: 30,
    backgroundColor: "currentColor",
    mask,
    WebkitMask: mask,
  };
}

function Tile({
  label,
  ariaLabel,
  image,
  glyphUrl,
  badge,
  onClick,
  dialog,
}: Omit<MobileHomeTile, "key" | "onOpen"> & {
  onClick: () => void;
  dialog?: boolean;
}) {
  return (
    <button
      type="button"
      data-mobile-shell-tile=""
      aria-label={ariaLabel ?? label}
      aria-haspopup={dialog ? "dialog" : undefined}
      onClick={onClick}
    >
      <span data-mobile-shell-tile-face="">
        {image ? (
          <img alt="" src={image} />
        ) : glyphUrl ? (
          <span aria-hidden="true" style={glyph(glyphUrl)} />
        ) : null}
        {badge ? <span data-mobile-shell-tile-badge="" /> : null}
      </span>
      <span data-mobile-shell-tile-label="">{label}</span>
    </button>
  );
}

export function MobileHomeScreen({
  tiles,
  header,
  cards,
  onOpenAllApps,
  allAppsGlyphUrl,
  covered,
  layoutProps,
  cardsProps,
  gridProps,
  clearanceProps,
  ...attributes
}: MobileHomeScreenProps) {
  return (
    <section
      aria-label="Home"
      {...attributes}
      data-mobile-shell-home=""
      aria-hidden={covered || undefined}
      inert={covered || undefined}
    >
      <style>{MOBILE_HOME_CSS}</style>
      <div {...layoutProps} data-mobile-shell-home-layout="">
        {header}
        {cards ? (
          <div {...cardsProps} data-mobile-shell-cards="">
            {cards}
            <div aria-hidden="true" style={{ flexShrink: 0, width: 12 }} />
          </div>
        ) : null}
        <div data-mobile-shell-home-spacer="" />
        <div {...gridProps} data-mobile-shell-apps="">
          {tiles.map(({ key, onOpen, ...tile }) => (
            <Tile key={key} {...tile} onClick={onOpen} />
          ))}
          {onOpenAllApps ? (
            <Tile
              label="All apps"
              glyphUrl={allAppsGlyphUrl}
              onClick={onOpenAllApps}
              dialog
            />
          ) : null}
        </div>
        <div data-mobile-shell-home-spacer="end" />
      </div>
      <div
        aria-hidden="true"
        {...clearanceProps}
        data-mobile-shell-home-clearance=""
      />
    </section>
  );
}
