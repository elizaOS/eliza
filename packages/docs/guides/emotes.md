---
title: "Emote Catalog"
sidebarTitle: "Emotes"
description: "Reference for all available agent emotes and the PLAY_EMOTE action."
---

Emotes are avatar animations that agents can play in 3D environments. The `PLAY_EMOTE` action triggers an animation by ID, and the agent responds with a text representation (e.g., `*waves*`).

## Using Emotes

The `PLAY_EMOTE` action accepts a single parameter:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `emote` | string (enum) | Yes | Emote ID from the catalog below. The parameter schema includes an `enum` of all valid IDs, so the LLM sees the allowed values directly in the action definition. |

Common natural-language mappings (included in the parameter description for the model):
- dance / vibe &rarr; `dance-happy`
- wave / greet &rarr; `wave`
- flip / backflip &rarr; `flip`
- cry / sad &rarr; `crying`
- fight / punch &rarr; `punching`
- fish &rarr; `fishing`

Alternative trigger names: `EMOTE`, `ANIMATE`, `GESTURE`, `DANCE`, `WAVE`, `PLAY_ANIMATION`, `DO_EMOTE`, `PERFORM`.

### Disabling emotes

Set `character.settings.DISABLE_EMOTES = true` to remove the `PLAY_EMOTE` action entirely at plugin init time. When disabled, the action never appears in the prompt.

## Emote Catalog

### Greeting

| ID | Name | Description | Duration | Loop |
|----|------|-------------|----------|------|
| `wave` | Wave | Waves both hands in greeting | 2.5s | No |
| `kiss` | Kiss | Blows a kiss | 2s | No |

### Emotion

| ID | Name | Description | Duration | Loop |
|----|------|-------------|----------|------|
| `crying` | Crying | Cries sadly | 3s | Yes |
| `sorrow` | Sorrow | Expresses deep sorrow | 3s | Yes |
| `rude-gesture` | Rude Gesture | Makes a rude gesture | 2s | No |
| `looking-around` | Looking Around | Looks around nervously | 3s | Yes |

### Dance

| ID | Name | Description | Duration | Loop |
|----|------|-------------|----------|------|
| `dance-happy` | Happy Dance | Happy dance | 4s | Yes |
| `dance-breaking` | Breaking | Breakdance moves | 4s | Yes |
| `dance-hiphop` | Hip Hop | Hip hop dance | 4s | Yes |
| `dance-popping` | Popping | Popping dance moves | 4s | Yes |

### Combat

| ID | Name | Description | Duration | Loop |
|----|------|-------------|----------|------|
| `hook-punch` | Hook Punch | Throws a hook punch | 1.5s | No |
| `punching` | Punching | Throws punches | 2s | No |
| `firing-gun` | Firing Gun | Fires a gun | 2s | No |
| `sword-swing` | Sword Swing | Swings a sword | 2s | No |
| `chopping` | Chopping | Chops with an axe | 2s | No |
| `spell-cast` | Spell Cast | Casts a magic spell | 2.5s | No |
| `range` | Range | Fires a ranged weapon | 2s | No |
| `death` | Death | Falls down defeated | 3s | No |

### Idle

| ID | Name | Description | Duration | Loop |
|----|------|-------------|----------|------|
| `idle` | Idle | Stands idle | 5s | Yes |
| `talk` | Talk | Talks animatedly | 3s | Yes |
| `squat` | Squat | Squats down | 3s | Yes |
| `fishing` | Fishing | Casts a fishing line | 5s | Yes |
| `float` | Float | Floats in the air | 4s | Yes |

### Movement

| ID | Name | Description | Duration | Loop |
|----|------|-------------|----------|------|
| `jump` | Jump | Jumps up | 1.5s | No |
| `flip` | Flip | Does a backflip | 2s | No |
| `run` | Run | Runs in place | 3s | Yes |
| `walk` | Walk | Walks in place | 3s | Yes |
| `crawling` | Crawling | Crawls on the ground | 3s | Yes |
| `fall` | Fall | Falls down | 2s | No |

## Programmatic Access

```typescript
import { getEmote, getEmotesByCategory, isValidEmote, EMOTE_CATALOG } from "eliza/emotes/catalog";

// Look up a single emote
const emote = getEmote("dance-happy");
// → { id: "dance-happy", name: "Happy Dance", duration: 4, loop: true, category: "dance", ... }

// Get all emotes in a category
const dances = getEmotesByCategory("dance");
// → [{ id: "dance-happy", ... }, { id: "dance-breaking", ... }, ...]

// Validate an emote ID
isValidEmote("wave");  // true
isValidEmote("foo");   // false
```

## Categories

| Category | Count | Description |
|----------|-------|-------------|
| `greeting` | 2 | Social greetings |
| `emotion` | 4 | Emotional expressions |
| `dance` | 4 | Dance animations |
| `combat` | 8 | Combat and action animations |
| `idle` | 5 | Standing and idle poses |
| `movement` | 6 | Locomotion animations |

**Total: 29 emotes** across 6 categories.

## Related

- [Custom Actions](/guides/custom-actions) — how PLAY_EMOTE fits into the action system
- [Chat Commands](/chat-commands) — triggering emotes in chat
