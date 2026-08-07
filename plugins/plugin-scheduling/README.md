# @elizaos/plugin-scheduling

The scheduling spine for elizaOS agents — the storage-agnostic ScheduledTask state machine, registries, runner, and the spine→reminders ports. See CLAUDE.md for the package contract.

> **Vocabulary:** a `ScheduledTask` record is a **scheduled item** (reminder / check-in / follow-up / …), distinct from a core **task**, an engine **workflow**, and an orchestrator **coding task**. The runner owns no timer — it is ticked by the single core `TaskService` clock via the `LIFEOPS_SCHEDULER` task.
