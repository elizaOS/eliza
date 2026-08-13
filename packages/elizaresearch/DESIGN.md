# Eliza Research design authority

This package holds the production orange page and three complete local review
cuts. The review cuts share content and behavior but make meaningfully different
layout choices. They are comparison artifacts, not production routes.

## Recommendation

**Reflow / Black** is the strongest match for the requested direction. It keeps
the particle mark as the room, preserves the original Reflow rail and edge
email gesture, and lets the orange dot field feel luminous without adding a
background illustration. **Research / Paper** is the clearest editorial
alternative. **Shaw / Orange** is the brand-first poster: a horizontal identity
bar, dark display type, and a white particle face on the literal Shaw orange.

Choose from `/reflow-compare`. Every card opens the same seven-page content set
in its own visual system: Home, About, Team, Contact, Particle study, Privacy,
and Terms.

## Visual system

- Orange: `#ff5800`, used as Shaw's brand field and primary accent.
- Ink: `#110e0c`; orange-field ink: `#351208`; paper: `#fffaf5`.
- Syne carries identity and display headlines. Geist carries body copy and UI.
- Reflow / Black uses a fixed vertical rail and bottom-weighted identity.
- Shaw / Orange uses a fixed horizontal bar and a left-copy/right-mark split.
- Research / Paper uses the same horizontal grammar with more whitespace,
  orange display type, and orange particles on paper.

All normal-size text and focus indicators target WCAG 2.2 AA. Interactive
targets are at least 44 CSS pixels in their designed responsive state. Below
768 pixels or 480 pixels of viewport height, every edition switches to a compact
top bar so navigation and contact remain reachable in short landscape.

## Particle motion

One `particle-logo.js` engine renders every surface. It samples unique opaque
pixels from the canonical Eliza SVG, uses round 0.5–1.5 CSS-pixel dots, and
scales the Reflow reference density of 8,500 dots by the square root of viewport
area.

The opening maps each dot to one of nine face regions, starts it in a nearby
cluster, and resolves the full mark with a 1.6-second quintic smootherstep and a
450-millisecond fade. The grouped idea comes from Shaw's Eliza Research motion;
direct interpolation replaces the spring overshoot, links, and large wobble.

After formation, a low-amplitude tangential wave keeps the mark alive at an
18-fps idle budget. Pointer input is smoothed and bends an oriented elliptical
field in the pointer's direction of travel. It is intentionally non-radial: the
cursor core retains particles, no bright ring or hollow disk appears, color
never changes, and offsets converge exactly to zero. Active drawing is capped
near 60 fps. Reduced motion renders a fully formed static mark; hidden or
offscreen canvases stop both animation lanes.

## Content and truth boundaries

`reflow-site.js` owns the site name, thesis, product summaries, contact address,
route rendering, and copy-email behavior for both `/` and the review cuts.
Edition CSS changes presentation only.

The contact interaction reports clipboard success only after the browser write
resolves. Denial becomes an explicit mail action. The supplied email address is
shown without claiming that inbound routing works; GitHub and X remain visible
alternatives. Team biographies, legal text, customer proof, benchmarks, and
backend product capabilities are not invented. Privacy and Terms are plainly
labeled placeholders and all review routes are `noindex`.
