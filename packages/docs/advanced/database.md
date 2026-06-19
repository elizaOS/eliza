---
title: Database
sidebarTitle: Database
description: Browse your Eliza agent's database — inspect tables, media files, and vector stores directly from the dashboard.
---

The Database tab provides a built-in browser for your agent's data stores. Access it from the **Advanced** section of the dashboard at `/database`.

## Overview

The database browser has three sub-tabs for different data types:

| Tab | Description |
|-----|-------------|
| **Tables** | Browse relational database tables — view rows, columns, and record counts |
| **Media** | Browse uploaded and generated media files (images, audio, video) |
| **Vectors** | Inspect vector store entries used for semantic search and RAG |

## Tables

The Tables view lists all database tables used by the agent runtime. Select a table to browse its contents in a paginated data grid.

Common tables include:

| Table | Contents |
|-------|----------|
| `memories` | Agent memories and conversation state |
| `messages` | Conversation history |
| `knowledge` / `documents` | Knowledge base documents and fragments |
| `entities` | People, agents, and other entities the agent knows about |
| `rooms` | Conversation rooms and channels |
| `tasks` | Scheduled and active tasks |
| `triggers` | Event triggers and their run history |

Select any table to view its rows in a paginated grid. Each row displays all columns with their values.

## Media Gallery

The Media view scans database tables for embedded media URLs (images, videos, audio) and presents them in a filterable, searchable grid with a lightbox viewer.

### How Media Is Discovered

The gallery scans up to 10 database tables, prioritizing tables whose names contain `memor`, `message`, `media`, `attach`, `file`, `asset`, or `document`. For each row, it extracts HTTP URLs and `data:` URIs from all string-valued columns, including JSON content blobs.

### Supported Media Types

| Type | Extensions | Badge Color |
|------|-----------|-------------|
| **Image** | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.bmp` `.ico` `.avif` | Blue |
| **Video** | `.mp4` `.webm` `.mov` `.avi` `.mkv` `.ogv` | Purple |
| **Audio** | `.mp3` `.wav` `.ogg` `.flac` `.aac` `.m4a` `.opus` | Green |

### Filtering

- **Text search** — filter by filename or URL (case-insensitive)
- **Type filter chips** — All / Images / Video / Audio (mutually exclusive)
- Results are deduplicated by URL and sorted by creation date (newest first)

### Lightbox

Click any media item to open the lightbox:

- **Images** display at up to 70% viewport height
- **Video** plays with native controls
- **Audio** plays with native controls
- Footer shows type, source table, and creation date
- Close with click outside, Escape, or Enter

## Vector Browser

The Vectors view browses agent memories and vector embeddings with three visualization modes. It auto-discovers vector-relevant tables (`memories`, `embeddings`, `knowledge`, `vector`) and joins embedding data when available.

### Toolbar

- **Table selector** — choose which vector table to browse
- **Stats bar** — total count, embedding dimensions, unique memory count
- **Search** — filter by content text (SQL `LIKE` query)
- **View mode toggle** — List, Graph (2D), or 3D
- **Refresh** — reload data

### Embedding Support

The viewer detects elizaOS embedding tables with dimension columns (`dim_384`, `dim_512`, `dim_768`, `dim_1024`, `dim_1536`, `dim_3072`). When the `memories` table is selected and an `embeddings` table exists, the viewer performs a LEFT JOIN to attach embedding vectors to memory records.

### List View

Paginated cards (25 per page). Each card shows:

- Content preview (first ~200 characters)
- Type badge and Unique badge
- Room ID, Entity ID, Created At
- Embedding dimension count (e.g., "384 dims")

Click any card to open the **Memory Detail Modal** with full content, metadata grid, embedding values, and raw JSON record.

### Graph View (2D Scatter Plot)

Projects high-dimensional embeddings to 2D using PCA (power iteration, 2 principal components). Renders to an HTML canvas.

- Axes labeled PC1 (horizontal) and PC2 (vertical)
- Points colored by memory `type` with a legend
- **Hover** — nearest point highlights with a tooltip showing content preview (60 chars)
- **Click** — opens the Memory Detail Modal
- Requires at least 2 records with embeddings (fetches up to 500)

### 3D View (Three.js)

Projects embeddings to 3 principal components and renders in an interactive Three.js scene.

- Each memory is a colored sphere positioned in 3D space
- **Mouse drag** — orbit camera around the scene (with damping)
- **Scroll wheel** — zoom in/out (radius clamped 2–15)
- **Hover** — highlighted sphere scales up with content tooltip (150 chars)
- **Click** — opens the Memory Detail Modal
- Scene includes a grid floor and 3-axis lines for spatial reference
- Points colored by memory type with a legend below the canvas

### Memory Detail Modal

Full-screen overlay showing:

- **Content** — full text in a scrollable panel
- **Metadata** — ID, Type, Room, Entity, Created At, Unique flag
- **Embedding preview** — all dimension values to 6 decimal places
- **Raw Record** — expandable JSON dump of the complete database row
