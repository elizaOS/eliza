# Product

## Register

product

## Users

The primary users are people running an Eliza agent on web, desktop, or mobile.
Most are not developers; they expect chat, voice, settings, notifications, and
agent-powered apps to work without understanding runtimes, plugins, providers,
or deployment topology.

The package also serves host-app and plugin developers who need stable,
accessible components, typed client APIs, and extension registries that behave
consistently across browser, Electrobun, and Capacitor environments.

## Product Purpose

Provide the shared interface system and front-end runtime boundary for elizaOS.
The package makes the agent feel like a coherent, trustworthy presence across
surfaces while giving integrators one canonical implementation for primitives,
shell behavior, API access, platform bridges, theming, and agent-controllable UI.

Success means end users get a clear, responsive, platform-appropriate
experience and integrators can compose or extend it without duplicating base
components, leaking implementation details, or depending on fragile internals.

## Brand Personality

Calm, warm, present. User-facing language is plain and approachable. The agent
feels like a companion with presence, not an administrative dashboard or a list
of technical capabilities.

## Anti-references

- Generic SaaS administration shells built from dense tables, metric tiles,
  nested cards, and permanent sidebar chrome.
- Cold AI-tool styling: gray-on-gray panels, gradient text, decorative glass,
  excessive borders, and motion without a functional purpose.
- Framework leakage that exposes terms such as runtime, plugin, or provider to
  users who only need to understand the task and its outcome.
- Platform-neutral web UI stretched unchanged across desktop and mobile.

The quality reference is restrained, system-native interaction with the clarity
and familiarity of first-party messaging applications.

## Design Principles

- **One canonical system.** Reuse primitives, tokens, registries, transports,
  and state owners rather than introducing parallel implementations.
- **Presence over dashboard.** Keep the primary experience conversational and
  calm; reveal operational detail only where it helps the current task.
- **Plain language over internals.** Product concepts describe user goals and
  outcomes, not the machinery that implements them.
- **Platform-aware by design.** Web, desktop, and mobile share contracts while
  preserving the interaction and layout needs of each environment.
- **Failure is visible.** Loading, empty, unavailable, and error states remain
  distinct; broken pipelines never masquerade as healthy empty results.

## Accessibility & Inclusion

WCAG AA is the baseline: body text reaches 4.5:1 contrast, keyboard and screen
reader operation cover every interactive flow, focus remains visible, touch
targets meet the 44px platform floor, and meaningful motion has a
`prefers-reduced-motion` alternative. State is never communicated by color
alone, and layouts remain usable under text scaling and narrow viewports.
