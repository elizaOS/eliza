---
title: "Form (advanced capability)"
sidebarTitle: "Form"
description: "Structured conversational forms — FORM service and related providers/actions built into elizaOS core."
---

Forms are **not** a separate installable plugin package. They ship inside **`@elizaos/core`** as part of **advanced capabilities**: `FormService` (service type `FORM`), form context provider, form evaluator, and related actions (see `packages/core/src/features/advanced-capabilities/form/`).

## Overview

Structured form flows support guided user journeys (collecting fields, restoring incomplete sessions, evaluating form-related dialogue). Capabilities register when advanced capabilities are enabled for the agent.

## Enabling

Toggle advanced capabilities in character / dashboard settings (`advancedCapabilities: true`), or control individual capability entries under `plugins.entries` for `form`, `experience`, `clipboard`, and `personality` (see `packages/agent/src/runtime/advanced-capabilities-config.ts`).

## Related

- [Services](/runtime/services) — service types and registry usage
- [Plugin architecture](/plugins/architecture) — advanced capabilities note for `personality`, `experience`, and `form`
