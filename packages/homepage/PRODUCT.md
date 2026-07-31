# Product

## Register

brand

## Users

People discovering Eliza for the first time, existing elizaOS users looking for
the fastest path into messaging or downloads, and technical evaluators checking
whether the product feels credible before they connect an account.

## Product Purpose

The homepage demonstrates Eliza as an agent that already lives inside familiar
messaging platforms, then moves visitors directly into onboarding. Success
means the experience communicates the product in one glance, stays interactive
while rich media loads, and makes the next action obvious on every device.

## Brand Personality

Fluid, playful, and direct. The interface should feel like a living consumer
product rather than a conventional software landing page: confident enough to
let the phone interaction and Eliza's voice carry the story.

## Anti-references

- Generic SaaS hero layouts with feature grids, decorative metrics, or abstract
  marketing copy in place of the working product demonstration.
- A static or oversized phone crop that turns the live interaction into a
  poster and wastes the viewport.
- Motion that delays interaction, fights user input, or consumes device
  resources without explaining state.
- Visual drift from the original Next.js eliza-app experience, which is the
  canonical reference for composition, scale, and interaction behavior.

## Design Principles

1. Show the product before explaining it.
2. Preserve the authored Next.js composition unless a change measurably
   improves responsiveness, accessibility, or performance.
3. Make rich motion progressive: useful controls render first, atmospheric and
   3D layers enhance them without blocking.
4. Treat frame time, download weight, and input latency as visible parts of the
   design.
5. Keep one clear path from curiosity to onboarding across desktop and mobile.

## Accessibility & Inclusion

Meet WCAG 2.2 AA for contrast, keyboard navigation, focus visibility, and
semantic controls. Respect `prefers-reduced-motion`, avoid motion-triggered
layout shifts, preserve readable zoom behavior, and keep primary touch targets
at least 44 by 44 CSS pixels.
