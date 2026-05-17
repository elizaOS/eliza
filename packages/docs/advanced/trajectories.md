---
title: Trajectories
sidebarTitle: Trajectories
description: View and analyze LLM call history for your Eliza agent — inspect prompts, responses, token usage, and latency.
---

The Trajectories tab provides a detailed viewer for your agent's LLM call history. Every call the agent makes to a language model is recorded as a trajectory, giving you full visibility into prompts, responses, token usage, and performance.

## Overview

Access Trajectories from the **Advanced** section of the dashboard at `/trajectories`. The viewer displays a reverse-chronological list of all LLM interactions.

## What's Recorded

Each trajectory entry captures:

| Field | Description |
|-------|-------------|
| **Timestamp** | When the LLM call was made |
| **Model** | Which model was used (e.g., GPT-4o, Claude Sonnet 4.6) |
| **Prompt** | The full prompt sent to the model, including system message and conversation history |
| **Response** | The model's complete response |
| **Token usage** | Input tokens, output tokens, and total |
| **Latency** | Time taken for the call to complete |
| **Status** | Success or error state |

## Using the Viewer

The trajectory list shows a summary card for each call. Click any entry to open the detail view, which displays the full prompt and response in a readable format.

### Filtering

Filter trajectories by:

- **Model** — narrow down to calls made to a specific model
- **Time range** — view calls from a specific period
- **Status** — filter by success or error

### Detail View

The detail view for an individual trajectory shows:

- Full prompt with system message, conversation history, and any tool calls
- Complete model response
- Token breakdown (input/output/total)
- Latency and timing information
- Error details if the call failed

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/trajectories` | List and search trajectory entries with filters |
| GET | `/api/trajectories/:id` | Get trajectory details with LLM calls and provider accesses |
| GET | `/api/trajectories/stats` | Get aggregate trajectory statistics |
| GET | `/api/trajectories/config` | Get trajectory logging configuration (enabled/disabled) |
| PUT | `/api/trajectories/config` | Enable or disable trajectory logging |
| POST | `/api/trajectories/export` | Export trajectories (JSON, CSV, ART, or ZIP) |
| DELETE | `/api/trajectories` | Delete trajectories (by IDs or all) |

See the [REST API Reference](/rest/trajectories) for full endpoint documentation.
