# elizaOS Cloud Design System

Source reference: https://elizaos.ai/

## Palette

The public site resolves to four brand anchors:

| Token | Hex | Use |
| --- | --- | --- |
| `--brand-blue` | `#0B35F1` | Sky/energy bands, focus rings, system/info state, link hover |
| `--brand-orange` | `#FF5800` | Primary conversion actions, selected state, active metrics |
| `--brand-black` | `#000000` | Text on light surfaces, dark shell background |
| `--brand-white` | `#FFFFFF` | Page background, text on black/orange/blue |

Use alpha variants of black, white, blue, and orange for hierarchy. Avoid adding gray, gold, green, or red as brand colors in Cloud-facing UI.

## Token Mapping

`packages/ui` is the source of truth:

```css
--accent: var(--brand-orange);
--primary: var(--brand-orange);
--status-info: var(--brand-blue);
--ring: var(--brand-blue);
--bg: var(--brand-white);
--text: var(--brand-black);
```

Dark Cloud shell:

```css
--bg: var(--brand-black);
--text: var(--brand-white);
--surface: rgba(255, 255, 255, 0.06);
--border: rgba(255, 255, 255, 0.12);
```

Light marketing shell:

```css
--bg: var(--brand-white);
--text: var(--brand-black);
--bg-accent: rgba(11, 53, 241, 0.08);
--border: rgba(0, 0, 0, 0.12);
```

## Typography

Default application font remains Open Sans through `--font-body`, `--font-display`, `--font-chat`, and `--mono`. Public elizaos.ai uses a Neue Haas Grotesk-style face; if that font is later licensed into the repo, it should replace only the variable values, not component classes.

Guidance:

- Hero titles: oversized, black or white, tight line-height.
- UI labels: small uppercase, but still Open Sans by default.
- Avoid typewriter fonts in user-facing Cloud, OS, and download surfaces.

## Shape

The public site uses mostly square geometry.

```css
--radius-sm: 0;
--radius-md: 2px;
--radius-lg: 4px;
--radius-xl: 4px;
--radius-2xl: 4px;
--radius-3xl: 4px;
```

Use hard corners for cards, nav, tabs, tables, stats, and primary buttons. Reserve `2px-4px` for inputs and dialogs.

## Layout Direction

Cloud dashboard:

- Black operational shell with white type.
- Orange for main actions and active state.
- Blue for focus, info, connection state, and hover energy.
- Rectangular modules with thin white alpha borders.

OS page:

- White/blue first viewport, black headline.
- Full-bleed product media from downloaded elizaos.ai assets.
- Black architecture band with white type.
- Minimal card chrome.

App download page:

- White utility surface with black type.
- Orange download CTA.
- Blue OS selector/focus.
- Black footer band mirroring public site.

