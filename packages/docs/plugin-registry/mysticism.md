---
title: "Mysticism Plugin"
sidebarTitle: "Mysticism"
description: "Mystical divination engines for Eliza — Tarot, I Ching, and Astrology readings."
---

The Mysticism plugin equips Eliza agents with divination capabilities, including Tarot card readings, I Ching consultations, and Astrology chart interpretations.

**Package:** `@elizaos/plugin-mysticism`

## Overview

This plugin provides three divination engines within the elizaOS runtime:

- **Tarot** — Draw and interpret cards from the Major and Minor Arcana
- **I Ching** — Cast hexagrams and provide readings from the Book of Changes
- **Astrology** — Generate and interpret astrological charts and horoscopes

Each engine produces structured readings that agents can use to respond to user queries about fortune, guidance, or self-reflection.

## Installation

```bash
eliza plugins install mysticism
```

## Configuration

No environment variables or configuration required. The plugin works out of the box once installed.

## Usage Examples

> "Draw a three-card Tarot spread for my career question."

> "Cast an I Ching hexagram about my upcoming decision."

> "What does my astrological chart say about this week?"

The agent interprets the results using the selected divination system and provides a narrative reading.
