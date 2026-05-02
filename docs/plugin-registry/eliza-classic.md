---
title: "Eliza Classic Plugin"
sidebarTitle: "Eliza Classic"
description: "Compatibility plugin for Eliza — original ELIZA-style patterns alongside legacy Eliza Classic behavior."
---

The Eliza Classic plugin brings the original 1966 ELIZA chatbot patterns into Eliza, providing Rogerian psychotherapist-style conversational responses alongside legacy Eliza Classic behavior.

**Package:** `@elizaos/plugin-eliza-classic`

## Overview

ELIZA was one of the first chatbot programs, created by Joseph Weizenbaum at MIT in 1966. It used pattern matching and substitution to simulate a Rogerian psychotherapist. This plugin implements those classic patterns within the elizaOS runtime, allowing agents to fall back to or incorporate ELIZA-style conversational techniques.

Note: "Eliza Classic" refers to the 1966 chatbot, not elizaOS.

## Installation

```bash
eliza plugins install eliza-classic
```

## Configuration

No environment variables or configuration required. The plugin works out of the box once installed.

## Usage

When loaded, the plugin makes ELIZA-style pattern matching available to agents. This can serve as a fallback conversational mode or as a novelty feature that pays homage to the origins of conversational AI.

> "Tell me about your problems."

> "How does that make you feel?"

The classic patterns follow Weizenbaum's original script, reflecting questions back to the user and prompting deeper self-reflection.
