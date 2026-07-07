# Product

## Register

product

## Users

Mainstream consumers running a personal AI agent (Eliza) on web, desktop
(Electrobun: macOS/Windows/Linux), or mobile (Capacitor: iOS/Android). Most
are not developers — they want an assistant that chats, remembers things,
handles voice, and helps with day-to-day tasks without caring how the
runtime works underneath. The backend is cloud-optional: the same UI serves
someone running fully local as well as someone logged into Eliza Cloud, so
the interface must never assume technical fluency or a specific deployment
topology.

## Product Purpose

Give people a single, trustworthy home for their AI agent — chat, voice,
notifications, settings, and app management — that feels like a natural
extension of their device rather than a dashboard bolted onto a model.
Success is an interface a non-technical person picks up and immediately
understands, across web, desktop, and mobile, without needing the concept of
"agent runtime" to use it well.

## Brand Personality

Warm, human, approachable. Three words: **calm, warm, present.** The agent
should read as a companion with presence, not a tool with a feature list.
Voice and tone stay plain-language and friendly; avoid technical jargon
("runtime", "plugin", "provider") in anything user-facing.

## Anti-references

- Generic SaaS admin dashboards (dense data tables, sidebar-nav-plus-cards,
  hero-metric tiles) — this is a companion app, not an enterprise console.
- Cold, corporate AI-tool chrome (heavy card borders, gray-on-gray panels,
  gradient-text logos) — reads as "AI slop," the opposite of the intended
  human warmth.
- Reference target: iMessage / Apple-native feel — clean, warm, system-native
  polish, restrained chrome, motion that feels physical rather than decorative.

## Design Principles

- **Feels native, not webby.** Platform-appropriate motion, spacing, and
  affordances on each of web/desktop/mobile rather than one generic web layout
  stretched across all three.
- **Plain language over jargon.** No runtime/plugin/provider concepts leak
  into user-facing copy or UI structure.
- **Presence over dashboard.** Favor a calm, conversational surface (chat,
  voice, gentle notifications) over dense data-table/admin patterns.
- **Cloud-optional, never cloud-assuming.** Every surface must work and look
  complete whether the agent is local-only or Cloud-backed.
- **Warmth through restraint.** Warmth is carried by tone, motion, and
  typography — not by defaulting to cream/sand palettes or decorative chrome.

## Accessibility & Inclusion

WCAG AA baseline: ≥4.5:1 body text contrast, visible focus states, full
`prefers-reduced-motion` alternatives for all transitions/animations, and
color choices checked against common color-vision deficiencies (never
color-only signal for state).
