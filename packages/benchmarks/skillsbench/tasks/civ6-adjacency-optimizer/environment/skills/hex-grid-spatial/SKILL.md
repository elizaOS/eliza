---
name: hex-grid-spatial
description: Hex grid spatial utilities for offset coordinate systems. Use when working with hexagonal grids, calculating distances, finding neighbors, or spatial queries on hex maps.
---

# Hex Grid Spatial Utilities

Utilities for hexagonal grid coordinate systems using **odd-r offset coordinates** (odd rows shifted right).

## Coordinate System

- Tile 0 is at bottom-left
- X increases rightward (columns)
- Y increases upward (rows)
- Odd rows (y % 2 == 1) are shifted right by half a hex

## Direction Indices

```
     2   1
      \ /
   3 - * - 0
      / \
     4   5

0=East, 1=NE, 2=NW, 3=West, 4=SW, 5=SE
```

## Core Functions

### Get Neighbors

```python
def get_neighbors(x: int, y: int) -> List[Tuple[int, int]]:
    """Get all 6 neighboring hex coordinates."""
    if y % 2 == 0:  # even row
        directions = [(1,0), (0,-1), (-1,-1), (-1,0), (-1,1), (0,1)]
    else:  # odd row - shifted right
        directions = [(1,0), (1,-1), (0,-1), (-1,0), (0,1), (1,1)]
    return [(x + dx, y + dy) for dx, dy in directions]
```

### Hex Distance

```python
def hex_distance(x1: int, y1: int, x2: int, y2: int) -> int:
    """Calculate hex distance using cube coordinate conversion."""
    def offset_to_cube(col, row):
        cx = col - (row - (row & 1)) // 2
        cz = row
        cy = -cx - cz
        return cx, cy, cz

    cx1, cy1, cz1 = offset_to_cube(x1, y1)
    cx2, cy2, cz2 = offset_to_cube(x2, y2)
    return (abs(cx1-cx2) + abs(cy1-cy2) + abs(cz1-cz2)) // 2
```

### Tiles in Range

```python
def get_tiles_in_range(x: int, y: int, radius: int) -> List[Tuple[int, int]]:
    """Get all tiles within radius (excluding center)."""
    tiles = []
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            nx, ny = x + dx, y + dy
            if (nx, ny) != (x, y) and hex_distance(x, y, nx, ny) <= radius:
                tiles.append((nx, ny))
    return tiles
```

## Usage Examples

```python
# Find neighbors of tile (21, 13)
neighbors = get_neighbors(21, 13)
# For odd row: [(22,13), (22,12), (21,12), (20,13), (21,14), (22,14)]

# Calculate distance
dist = hex_distance(21, 13, 24, 13)  # Returns 3

# Check adjacency
is_adj = hex_distance(21, 13, 21, 14) == 1  # True

# Get all tiles within 3 of city center
workable = get_tiles_in_range(21, 13, 3)
```

## Key Insight: Even vs Odd Row

The critical difference is in directions 1, 2, 4, 5 (the diagonal directions):

| Direction | Even Row (y%2==0) | Odd Row (y%2==1) |
|-----------|-------------------|------------------|
| NE (1) | (0, -1) | (1, -1) |
| NW (2) | (-1, -1) | (0, -1) |
| SW (4) | (-1, +1) | (0, +1) |
| SE (5) | (0, +1) | (1, +1) |

East (0) and West (3) are always (1, 0) and (-1, 0).
