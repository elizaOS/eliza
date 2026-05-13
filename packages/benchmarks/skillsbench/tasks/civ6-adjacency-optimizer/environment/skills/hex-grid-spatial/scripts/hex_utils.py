"""Hex grid utilities for Civ6 offset coordinate system.

Civ6 uses an "odd-r" (odd-row) horizontal offset coordinate system.
Odd rows are shifted right by half a hex.

This module provides pure functions for hex math operations.
All functions are stateless and easily unit testable.
"""

from typing import List, Tuple, Optional

# Direction offsets for hex neighbors
# Civ6 uses "odd-r" offset coordinates (odd ROWS shifted right)
# Index corresponds to edge direction: 0=E, 1=NE, 2=NW, 3=W, 4=SW, 5=SE

# For EVEN rows (y % 2 == 0)
DIRECTIONS_EVEN_ROW = [
    (1, 0),    # 0: East
    (0, -1),   # 1: Northeast
    (-1, -1),  # 2: Northwest
    (-1, 0),   # 3: West
    (-1, 1),   # 4: Southwest
    (0, 1),    # 5: Southeast
]

# For ODD rows (y % 2 == 1)
DIRECTIONS_ODD_ROW = [
    (1, 0),    # 0: East
    (1, -1),   # 1: Northeast (shifted right for odd rows)
    (0, -1),   # 2: Northwest
    (-1, 0),   # 3: West
    (0, 1),    # 4: Southwest
    (1, 1),    # 5: Southeast (shifted right for odd rows)
]


def get_neighbors(x: int, y: int) -> List[Tuple[int, int]]:
    """Get all 6 neighboring hex coordinates.

    Args:
        x: Column
        y: Row

    Returns:
        List of (x, y) tuples for all 6 neighbors

    Example:
        >>> get_neighbors(21, 14)  # y=14 is even row
        [(22, 14), (21, 13), (20, 13), (20, 14), (20, 15), (21, 15)]
    """
    directions = DIRECTIONS_ODD_ROW if y % 2 == 1 else DIRECTIONS_EVEN_ROW
    return [(x + dx, y + dy) for dx, dy in directions]


def get_neighbor_at_direction(x: int, y: int, direction: int) -> Tuple[int, int]:
    """Get neighbor coordinate in a specific direction.

    Args:
        x, y: Current position
        direction: Edge direction (0-5)

    Returns:
        (x, y) of neighbor in that direction
    """
    directions = DIRECTIONS_ODD_ROW if y % 2 == 1 else DIRECTIONS_EVEN_ROW
    dx, dy = directions[direction]
    return (x + dx, y + dy)


def get_direction_to_neighbor(x1: int, y1: int, x2: int, y2: int) -> Optional[int]:
    """Get the direction from (x1,y1) to adjacent tile (x2,y2).

    Args:
        x1, y1: Source position
        x2, y2: Target position (must be adjacent)

    Returns:
        Direction index (0-5) or None if not adjacent

    Example:
        >>> get_direction_to_neighbor(5, 5, 6, 5)
        0  # East
    """
    neighbors = get_neighbors(x1, y1)
    try:
        return neighbors.index((x2, y2))
    except ValueError:
        return None


def hex_distance(x1: int, y1: int, x2: int, y2: int) -> int:
    """Calculate hex distance between two positions.

    Uses cube coordinate conversion for accurate distance.
    Civ6 uses "odd-r" offset coordinates (odd rows shifted right).

    Args:
        x1, y1: First position
        x2, y2: Second position

    Returns:
        Integer distance in hex tiles

    Example:
        >>> hex_distance(0, 0, 3, 0)
        3
        >>> hex_distance(0, 0, 1, 1)
        1
    """
    # Convert offset (odd-r) to cube coordinates
    def offset_to_cube(col: int, row: int) -> Tuple[int, int, int]:
        cx = col - (row - (row & 1)) // 2
        cz = row
        cy = -cx - cz
        return cx, cy, cz

    cx1, cy1, cz1 = offset_to_cube(x1, y1)
    cx2, cy2, cz2 = offset_to_cube(x2, y2)

    return (abs(cx1 - cx2) + abs(cy1 - cy2) + abs(cz1 - cz2)) // 2


def is_adjacent(x1: int, y1: int, x2: int, y2: int) -> bool:
    """Check if two hexes are adjacent.

    Example:
        >>> is_adjacent(5, 5, 6, 5)
        True
        >>> is_adjacent(0, 0, 2, 0)
        False
    """
    return hex_distance(x1, y1, x2, y2) == 1


def get_tiles_in_range(x: int, y: int, radius: int) -> List[Tuple[int, int]]:
    """Get all tiles within a given range of a center tile.

    Args:
        x, y: Center position
        radius: Maximum distance (inclusive)

    Returns:
        List of (x, y) positions within range (excluding center)

    Example:
        >>> len(get_tiles_in_range(5, 5, 1))
        6  # Just the immediate neighbors
        >>> len(get_tiles_in_range(5, 5, 2))
        18  # Two rings
    """
    tiles = []
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            nx, ny = x + dx, y + dy
            if (nx, ny) != (x, y) and hex_distance(x, y, nx, ny) <= radius:
                tiles.append((nx, ny))
    return tiles


def get_opposite_direction(direction: int) -> int:
    """Get the opposite direction (180 degrees).

    Example:
        >>> get_opposite_direction(0)  # East
        3  # West
    """
    return (direction + 3) % 6
