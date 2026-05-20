---
version: "alpha"
name: "elizaOS"
description: "Agent-first product UI for elizaOS apps, dynamic views, voice setup, trace surfaces, and runtime gates."
colors:
  primary: "#050507"
  secondary: "#9EA0AA"
  tertiary: "#FF5800"
  neutral: "#F6F6F8"
  background: "#0A0B0F"
  surface: "#111318"
  surface-muted: "#181B22"
  border: "#2A2D36"
  accent: "#FF5800"
  accent-hover: "#FF6D1F"
  accent-soft: "#2A170D"
  gold: "#FFE600"
  gold-muted: "#F0B90B"
  success: "#22C55E"
  warning: "#F59E0B"
  danger: "#EF4444"
  text: "#F6F6F8"
  text-muted: "#A6A6B0"
  text-subtle: "#6F7280"
typography:
  display:
    fontFamily: Poppins
    fontSize: 2rem
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: 0
  heading:
    fontFamily: Poppins
    fontSize: 1.25rem
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0
  body:
    fontFamily: Open Sans
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  body-sm:
    fontFamily: Open Sans
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  label:
    fontFamily: Poppins
    fontSize: 0.75rem
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0
  mono-label:
    fontFamily: ui-monospace
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: 0.16em
rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 12px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
components:
  app-background:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "{spacing.lg}"
  panel-muted:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "{spacing.md}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.sm}"
    padding: "{spacing.md}"
  button-secondary:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "{spacing.md}"
  runtime-primary:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.primary}"
    rounded: "{rounded.none}"
    padding: "{spacing.md}"
  status-success:
    backgroundColor: "#0E2A18"
    textColor: "{colors.success}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  status-warning:
    backgroundColor: "#2A1B08"
    textColor: "{colors.warning}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
---

## Overview

elizaOS UI is agent-first operational software. The product should feel like a capable local agent is already present, not like a dashboard the user has to learn before anything works.

The main design job is to remove decisions, not decorate them. First-run should get the user to a talking/running agent quickly, then let the agent reveal setup choices through contextual generative UI.

## Colors

Use dark surfaces, high-contrast text, and one clear action accent. The default app accent is orange. The first-run runtime gate may use yellow/gold for the immersive launch moment, but it should not leak into every settings or operational surface.

Success, warning, and danger colors are only for status. Do not use them as decorative palette drivers.

## Typography

Use Poppins for headings and labels. Use Open Sans for readable body copy. Use mono labels only for runtime/terminal/diagnostic affordances where the technical tone is intentional.

Do not scale type with viewport width. Keep letter spacing at `0` by default; only use wide tracking for short uppercase runtime labels.

## Layout

Mobile first-run screens must respect safe areas and keep the primary action reachable without scrolling. Avoid vertically centering compact cards low on tall phone screens. Place onboarding/runtime cards in the upper-middle of the viewport unless the content genuinely needs centered composition.

Product surfaces should be dense, calm, and useful. Avoid landing-page hero layouts inside the app. Avoid nested cards. Use full-width bands or direct layouts for page structure, and reserve cards for repeated items, modals, and framed tools.

## Elevation & Depth

Use borders and subtle shadows instead of heavy glass effects. Runtime gate zine panels may use hard-edged shadows, clipped corners, and high contrast. Main app surfaces should stay quieter.

## Shapes

Use 4px to 8px radius for most interface elements. Icon buttons and tool controls may be square or circular when that matches the control metaphor. Do not use pill styling by default.

## Components

Primary buttons are for the next concrete action. Secondary buttons are for alternate paths. Advanced paths belong behind disclosure when they are not needed for the common case.

Generated UI, dynamic views, trace views, terminal output, file trees, Git diffs, and voice timelines should render through reusable `packages/ui` components. They should not execute capabilities directly.

## Do's and Don'ts

Do boot into the smallest useful experience.

Do use the agent to explain and perform setup when possible.

Do keep voice and runtime setup short, direct, and recoverable.

Do keep bottom actions inside the safe area and visibly tappable on phone screens.

Do not show old wizard screens, provisioning dashboards, or static setup detours when a direct runtime action can proceed.

Do not ask the user to understand deployment mechanics before the agent works.

Do not hide failed capability or backend states behind onboarding copy.

Do not let visual components call filesystem, terminal, Git, model, sandbox, or Satellite APIs directly.
