---
title: "Form"
sidebarTitle: "Form"
description: "Structured conversational forms — FORM service, provider, evaluator, and restore action from @elizaos/plugin-form."
---

Forms ship as the standalone **`@elizaos/plugin-form`** package. The plugin owns `FormService` (service type `FORM`), the `FORM_CONTEXT` provider, the `form_evaluator`, and the `FORM_RESTORE` action.

## Overview

Structured form flows support guided user journeys (collecting fields, restoring incomplete sessions, evaluating form-related dialogue). Capabilities register when `@elizaos/plugin-form` is enabled for the agent.

## Enabling

Enable the `form` plugin entry in character / dashboard settings, or include `@elizaos/plugin-form` in the plugin allow list. Advanced capabilities no longer register the FORM runtime.

## Related

- [Services](/runtime/services) — service types and registry usage
- [Plugin architecture](/plugins/architecture) — plugin registration and lifecycle
