---
title: "Scheduling & recurring tasks"
sidebarTitle: "Cron (legacy topic)"
description: "Cron-style and interval scheduling in elizaOS via TaskService, task workers, and triggers — the @elizaos/plugin-cron package is not used in this tree."
---

The **`@elizaos/plugin-cron` npm package and `plugins/plugin-cron` submodule are removed** from this repository.

Scheduling and recurring work use the runtime **TaskService** (`serviceType`: `"task"`, `ServiceType.TASK` in `@elizaos/core`) together with **triggers** and the dashboard/API surface around `/api/triggers` and `TRIGGER_DISPATCH`.

For product-facing docs on triggers and tasks, see **Runtime → Services** and **Tasks / triggers** sections in the main documentation.
