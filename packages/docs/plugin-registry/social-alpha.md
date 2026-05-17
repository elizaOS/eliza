---
title: "Social Alpha Plugin"
sidebarTitle: "Social Alpha"
description: "Social Alpha plugin for Eliza — tracks token recommendations, builds trust scores."
---

The Social Alpha plugin enables Eliza agents to track token recommendations (shills and FUD) and build trust scores for social signal analysis.

**Package:** `@elizaos/plugin-social-alpha`

## Overview

This plugin provides a social signal tracking layer within the elizaOS runtime. It monitors token recommendations from various sources, categorizing them as positive (shills) or negative (FUD), and maintains trust scores based on historical accuracy. Agents can use this data to evaluate the reliability of social signals and inform decision-making.

## Installation

```bash
eliza plugins install social-alpha
```

## Configuration

No environment variables or configuration required. The plugin works out of the box once installed.

## Features

- **Recommendation tracking** — Records token mentions with sentiment (positive shill or negative FUD)
- **Trust scoring** — Builds and maintains trust scores for recommendation sources based on historical accuracy
- **Signal aggregation** — Combines signals across sources to surface consensus or divergence

## Usage

Once installed, agents can query tracked recommendations and trust scores to evaluate social signals around specific tokens. The plugin stores recommendation history in the agent's database adapter.
