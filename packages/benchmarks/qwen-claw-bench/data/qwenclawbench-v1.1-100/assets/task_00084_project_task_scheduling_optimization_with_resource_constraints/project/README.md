# Project Scheduling Optimization

## Overview

This workspace contains data for a **project scheduling optimization problem**. The goal is to determine the optimal assignment of tasks to workers and their start/end times in order to **minimize the total project makespan** (i.e., the time from project start to when all tasks are complete).

## Problem Description

We have a set of 6 tasks (A through F) that must be completed by a team of 2 workers. Each task has a fixed duration, and there are dependency constraints that dictate the order in which tasks can be executed. Each worker can handle only one task at a time.

## Data Files

| File | Description |
|------|-------------|
| `tasks.json` | **Primary task definitions** — contains task IDs, names, descriptions, and durations in hours. |
| `dependencies.yaml` | **Dependency graph** — specifies which tasks must be completed before each task can start. |
| `resources.csv` | **Resource information** — lists available workers and their capacity constraints. |
| `team_capacity.json` | **Team capacity constraints** — confirms team size and parallelism limits. |

## Objective

Produce an optimal schedule that:

1. Respects all task dependencies (a task cannot start until all prerequisites are finished).
2. Respects resource constraints (each worker handles at most 1 task at a time; 2 workers available).
3. Minimizes the **makespan** — the total elapsed time from the start of the first task to the completion of the last task.

## Output

The result should be written to `schedule_result.md` and include:
- The optimal schedule (task assignments, start times, end times)
- The critical path analysis
- The minimum makespan value

## Notes

- All task durations are specified in **hours**.
- Refer to `tasks.json` as the authoritative source for task durations.
- Refer to `dependencies.yaml` as the authoritative source for the dependency graph.
