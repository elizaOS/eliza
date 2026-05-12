"""District placement rules for Civ6 (Gathering Storm).

This module defines which tiles are valid for each district type.
Designed to be extensible for civilization-specific unique districts.

Reference: https://civilization.fandom.com/wiki/District_(Civ6)

PLACEMENT RULES SUMMARY:
========================
All Districts:
- Must be within 3 tiles of City Center
- Cannot be on: Mountains, Natural Wonders, Strategic/Luxury resources
- Cannot be on tiles with existing districts/wonders
- CAN be on: Bonus resources (destroys them), Woods/Rainforest/Marsh (destroys them)

Specific District Rules:
- Harbor, Water Park: Must be on Coast/Lake adjacent to land
- Aerodrome, Spaceport: Must be on FLAT land (no hills)
- Encampment, Preserve: Cannot be adjacent to City Center
- Aqueduct: Must be adjacent to City Center AND fresh water source
- Dam: Must be on Floodplains, river must traverse 2+ edges
- Canal: Must connect water bodies or City Center to water
"""

from dataclasses import dataclass
from enum import IntEnum, auto
from typing import Dict, List, Optional, Set, Tuple, Callable, Any

from hex_utils import hex_distance, get_neighbors, get_direction_to_neighbor, is_adjacent


class DistrictType(IntEnum):
    """All district types in Civ6."""
    NONE = 0
    CITY_CENTER = auto()
    # Specialty districts (count towards population limit)
    CAMPUS = auto()
    HOLY_SITE = auto()
    THEATER_SQUARE = auto()
    COMMERCIAL_HUB = auto()
    HARBOR = auto()
    INDUSTRIAL_ZONE = auto()
    ENTERTAINMENT_COMPLEX = auto()
    WATER_PARK = auto()
    ENCAMPMENT = auto()
    AERODROME = auto()
    GOVERNMENT_PLAZA = auto()
    DIPLOMATIC_QUARTER = auto()
    PRESERVE = auto()
    # Non-specialty districts (no population limit)
    AQUEDUCT = auto()
    DAM = auto()
    CANAL = auto()
    SPACEPORT = auto()
    NEIGHBORHOOD = auto()


# Map string names to enum
DISTRICT_NAME_MAP: Dict[str, DistrictType] = {
    d.name: d for d in DistrictType if d != DistrictType.NONE
}


@dataclass
class Tile:
    """Represents a single map tile with all relevant properties."""
    x: int
    y: int
    terrain: str  # GRASS, PLAINS, DESERT, TUNDRA, SNOW, COAST, OCEAN, MOUNTAIN
    feature: Optional[str] = None  # FEATURE_FOREST, FEATURE_JUNGLE, etc.
    is_hills: bool = False
    is_floodplains: bool = False
    river_edges: List[int] = None  # Which edges (0-5) have rivers
    river_names: List[str] = None
    resource: Optional[str] = None
    resource_type: Optional[str] = None  # STRATEGIC, LUXURY, BONUS
    improvement: Optional[str] = None  # MINE, QUARRY, LUMBER_MILL, etc.

    def __post_init__(self):
        if self.river_edges is None:
            self.river_edges = []
        if self.river_names is None:
            self.river_names = []

    @property
    def is_water(self) -> bool:
        return self.terrain in ("COAST", "OCEAN", "LAKE")

    @property
    def is_coast(self) -> bool:
        return self.terrain == "COAST"

    @property
    def is_lake(self) -> bool:
        return self.terrain == "LAKE"

    @property
    def is_mountain(self) -> bool:
        return self.terrain == "MOUNTAIN"

    @property
    def is_natural_wonder(self) -> bool:
        return self.feature is not None and "NATURAL_WONDER" in self.feature

    @property
    def has_river(self) -> bool:
        return len(self.river_edges) > 0

    @property
    def is_flat_land(self) -> bool:
        """Flat land = not water, not mountain, not hills."""
        return not self.is_water and not self.is_mountain and not self.is_hills


# =============================================================================
# CITY DISTANCE RULES
# =============================================================================

# Minimum distance between city centers (same landmass)
MIN_CITY_DISTANCE_SAME_LANDMASS = 4  # 4 tiles center-to-center (3 tiles between)

# Minimum distance between city centers (different landmasses)
MIN_CITY_DISTANCE_DIFFERENT_LANDMASS = 3  # 3 tiles center-to-center (2 tiles between)


def validate_city_distances(
    city_centers: List[Tuple[int, int]],
    tiles: Dict[Tuple[int, int], Tile],
) -> Tuple[bool, List[str]]:
    """
    Validate that all cities respect minimum distance requirements.

    Args:
        city_centers: List of (x, y) coordinates for each city center
        tiles: Dictionary of all map tiles

    Returns:
        (valid, errors) tuple
    """
    errors = []

    for i, city_a in enumerate(city_centers):
        for j, city_b in enumerate(city_centers):
            if j <= i:
                continue  # Only check each pair once

            distance = hex_distance(city_a[0], city_a[1], city_b[0], city_b[1])

            # Determine if cities are on same or different landmasses
            # Simple heuristic: check if there's water between them
            same_landmass = _are_cities_on_same_landmass(city_a, city_b, tiles)

            min_distance = (
                MIN_CITY_DISTANCE_SAME_LANDMASS if same_landmass
                else MIN_CITY_DISTANCE_DIFFERENT_LANDMASS
            )

            if distance < min_distance:
                errors.append(
                    f"Cities at {city_a} and {city_b} are too close: "
                    f"distance={distance}, minimum={min_distance} "
                    f"({'same' if same_landmass else 'different'} landmass)"
                )

    return len(errors) == 0, errors


def _are_cities_on_same_landmass(
    city_a: Tuple[int, int],
    city_b: Tuple[int, int],
    tiles: Dict[Tuple[int, int], Tile],
) -> bool:
    """
    Determine if two cities are on the same landmass.

    Uses simple heuristic: BFS from city_a to city_b through land tiles only.
    If we can reach city_b, they're on the same landmass.

    Note: This is a simplified check. The actual game uses area IDs.
    For most scenarios, checking if both cities are on land suffices.
    """
    # Get tiles at city locations
    tile_a = tiles.get(city_a)
    tile_b = tiles.get(city_b)

    # If either tile is water, they're on different "landmasses"
    if tile_a is None or tile_b is None:
        return True  # Assume same landmass if tiles not defined

    if tile_a.is_water or tile_b.is_water:
        return False

    # Simple BFS to check land connectivity
    visited = set()
    queue = [city_a]

    while queue:
        current = queue.pop(0)
        if current == city_b:
            return True

        if current in visited:
            continue
        visited.add(current)

        # Check all neighbors
        for nx, ny in get_neighbors(current[0], current[1]):
            if (nx, ny) in visited:
                continue

            neighbor_tile = tiles.get((nx, ny))
            if neighbor_tile is None:
                continue

            # Only traverse through land tiles
            if not neighbor_tile.is_water:
                queue.append((nx, ny))

    return False


# =============================================================================
# DISTRICT LIMIT AND UNIQUENESS VALIDATION
# =============================================================================

def calculate_max_specialty_districts(population: int) -> int:
    """
    Calculate max specialty districts for a city.

    Formula: 1 + floor((population - 1) / 3)

    Args:
        population: City population

    Returns:
        Maximum number of specialty districts allowed
    """
    return 1 + (population - 1) // 3


def validate_district_count(
    placements: Dict[str, Tuple[int, int]],
    population: int,
) -> Tuple[bool, List[str]]:
    """
    Validate that the number of specialty districts doesn't exceed the limit.

    Args:
        placements: Dict of district_name -> (x, y) coordinates
        population: City population

    Returns:
        (valid, errors) tuple
    """
    errors = []

    # Count specialty districts
    specialty_count = 0
    for district_name in placements:
        if district_name not in DISTRICT_NAME_MAP:
            continue
        district_type = DISTRICT_NAME_MAP[district_name]
        if district_type not in PlacementRules.NON_SPECIALTY_DISTRICTS:
            specialty_count += 1

    max_allowed = calculate_max_specialty_districts(population)

    if specialty_count > max_allowed:
        errors.append(
            f"Too many specialty districts: {specialty_count} placed, "
            f"but population {population} only allows {max_allowed} "
            f"(formula: 1 + floor(({population}-1)/3))"
        )

    return len(errors) == 0, errors


def validate_district_uniqueness(
    placements: Dict[str, Tuple[int, int]],
    city_id: str = "city",
    all_placements: Optional[Dict[str, Dict[str, Tuple[int, int]]]] = None,
) -> Tuple[bool, List[str]]:
    """
    Validate that districts aren't duplicated incorrectly.

    Rules:
    - Most specialty districts: ONE per city
    - Neighborhood: Multiple per city allowed
    - Government Plaza: ONE per civilization

    Args:
        placements: Dict of district_name -> (x, y) for this city
        city_id: Identifier for this city (for error messages)
        all_placements: For multi-city scenarios, dict of city_id -> placements
                       Used to check one-per-civilization districts

    Returns:
        (valid, errors) tuple
    """
    errors = []

    # Count districts by type for this city
    district_counts: Dict[str, int] = {}
    for district_name in placements:
        district_counts[district_name] = district_counts.get(district_name, 0) + 1

    # Check for duplicates within this city
    for district_name, count in district_counts.items():
        if district_name not in DISTRICT_NAME_MAP:
            continue

        district_type = DISTRICT_NAME_MAP[district_name]

        # Skip districts that allow multiples
        if district_type in PlacementRules.ALLOW_MULTIPLE_PER_CITY:
            continue

        if count > 1:
            errors.append(
                f"Duplicate district in {city_id}: {district_name} placed {count} times "
                f"(only 1 allowed per city)"
            )

    # Check one-per-civilization districts across all cities
    if all_placements is not None:
        for district_type in PlacementRules.ONE_PER_CIVILIZATION:
            district_name = district_type.name
            civ_count = 0
            cities_with_district = []

            for cid, city_placements in all_placements.items():
                if district_name in city_placements:
                    civ_count += 1
                    cities_with_district.append(cid)

            if civ_count > 1:
                errors.append(
                    f"{district_name} can only be built once per civilization, "
                    f"but found in {civ_count} cities: {cities_with_district}"
                )

    return len(errors) == 0, errors


@dataclass
class PlacementResult:
    """Result of a placement validation check."""
    valid: bool
    errors: List[str] = None
    warnings: List[str] = None

    def __post_init__(self):
        if self.errors is None:
            self.errors = []
        if self.warnings is None:
            self.warnings = []


class PlacementRules:
    """
    District placement rules engine.

    Designed to be subclassed for civilization-specific rules.
    Override methods like `_validate_unique_district()` for civ uniques.
    """

    # Districts that must be on water
    WATER_DISTRICTS: Set[DistrictType] = {
        DistrictType.HARBOR,
        DistrictType.WATER_PARK,
    }

    # Districts that require flat land (no hills)
    FLAT_LAND_DISTRICTS: Set[DistrictType] = {
        DistrictType.AERODROME,
        DistrictType.SPACEPORT,
    }

    # Districts that cannot be adjacent to City Center
    NO_CITY_CENTER_ADJACENT: Set[DistrictType] = {
        DistrictType.ENCAMPMENT,
        DistrictType.PRESERVE,
    }

    # Districts that don't count towards population limit
    NON_SPECIALTY_DISTRICTS: Set[DistrictType] = {
        DistrictType.AQUEDUCT,
        DistrictType.DAM,
        DistrictType.CANAL,
        DistrictType.SPACEPORT,
        DistrictType.NEIGHBORHOOD,
        DistrictType.CITY_CENTER,
    }

    # Districts that can be built multiple times per city
    # Most specialty districts are limited to ONE per city
    ALLOW_MULTIPLE_PER_CITY: Set[DistrictType] = {
        DistrictType.NEIGHBORHOOD,  # Can build multiple
        # Non-specialty districts can also have multiple
        DistrictType.AQUEDUCT,
        DistrictType.DAM,
        DistrictType.CANAL,
        DistrictType.SPACEPORT,
    }

    # Districts limited to ONE per civilization (not per city)
    ONE_PER_CIVILIZATION: Set[DistrictType] = {
        DistrictType.GOVERNMENT_PLAZA,
        DistrictType.DIPLOMATIC_QUARTER,
    }

    # Features that are destroyed when placing a district
    DESTRUCTIBLE_FEATURES: Set[str] = {
        "FEATURE_FOREST",   # Woods
        "FEATURE_JUNGLE",   # Rainforest
        "FEATURE_MARSH",    # Marsh
    }

    def __init__(
        self,
        tiles: Dict[Tuple[int, int], Tile],
        city_center: Tuple[int, int],
        population: int,
    ):
        self.tiles = tiles
        self.city_center = city_center
        self.population = population

    def get_tile(self, x: int, y: int) -> Optional[Tile]:
        return self.tiles.get((x, y))

    def max_specialty_districts(self) -> int:
        """Calculate max specialty districts based on population.

        Formula: 1 + floor((population - 1) / 3)

            Pop 1: 1 district
            Pop 4: 2 districts
            Pop 7: 3 districts
            Pop 10: 4 districts
            etc.
        """
        return 1 + (self.population - 1) // 3

    def validate_placement(
        self,
        district_type: DistrictType,
        x: int,
        y: int,
        existing_placements: Dict[Tuple[int, int], DistrictType],
    ) -> PlacementResult:
        """
        Validate if a district can be placed at (x, y).

        Args:
            district_type: Type of district to place
            x, y: Target coordinates
            existing_placements: Already placed districts {(x,y): type}

        Returns:
            PlacementResult with valid=True/False and error messages
        """
        errors: List[str] = []
        warnings: List[str] = []

        tile = self.get_tile(x, y)

        # Basic checks
        if tile is None:
            errors.append(f"No tile data at ({x}, {y})")
            return PlacementResult(valid=False, errors=errors)

        # Distance from City Center (must be within 3 tiles)
        distance = hex_distance(x, y, self.city_center[0], self.city_center[1])
        if distance > 3:
            errors.append(f"Too far from City Center (distance {distance} > 3)")

        # Cannot place on mountains
        if tile.is_mountain:
            errors.append("Cannot place district on Mountain")

        # Cannot place on natural wonders
        if tile.is_natural_wonder:
            errors.append("Cannot place district on Natural Wonder")

        # Cannot place on geothermal fissures (except City Center which is pre-placed)
        # Note: City Center CAN be settled on geothermal, and it's NOT destroyed
        if tile.feature == "FEATURE_GEOTHERMAL_FISSURE":
            errors.append("Cannot place district on Geothermal Fissure")

        # Cannot place on existing district
        if (x, y) in existing_placements:
            existing = existing_placements[(x, y)]
            errors.append(f"Tile already has district: {existing.name}")

        # Cannot place on strategic/luxury resources
        if tile.resource_type in ("STRATEGIC", "LUXURY"):
            errors.append(f"Cannot place on {tile.resource_type.lower()} resource: {tile.resource}")

        # Water district rules
        if district_type in self.WATER_DISTRICTS:
            if not (tile.is_coast or tile.is_lake):
                errors.append(f"{district_type.name} must be on Coast or Lake")
            # Check adjacent to land
            has_land_neighbor = False
            for nx, ny in get_neighbors(x, y):
                ntile = self.get_tile(nx, ny)
                if ntile and not ntile.is_water:
                    has_land_neighbor = True
                    break
            if not has_land_neighbor:
                errors.append(f"{district_type.name} must be adjacent to land")
        else:
            # Land districts cannot be on water
            if tile.is_water:
                errors.append(f"{district_type.name} cannot be placed on water")

        # Flat land requirement
        if district_type in self.FLAT_LAND_DISTRICTS:
            if not tile.is_flat_land:
                errors.append(f"{district_type.name} requires flat land (no hills, water, or mountains)")

        # Cannot be adjacent to City Center
        if district_type in self.NO_CITY_CENTER_ADJACENT:
            if hex_distance(x, y, self.city_center[0], self.city_center[1]) == 1:
                errors.append(f"{district_type.name} cannot be adjacent to City Center")

        # Aqueduct special rules
        if district_type == DistrictType.AQUEDUCT:
            aqueduct_errors = self._validate_aqueduct(x, y, existing_placements)
            errors.extend(aqueduct_errors)

        # Dam special rules
        if district_type == DistrictType.DAM:
            dam_errors = self._validate_dam(x, y, existing_placements)
            errors.extend(dam_errors)

        # Canal special rules
        if district_type == DistrictType.CANAL:
            canal_errors = self._validate_canal(x, y, existing_placements)
            errors.extend(canal_errors)

        # Warnings for feature/resource destruction
        if tile.feature in self.DESTRUCTIBLE_FEATURES:
            warnings.append(f"Placing here will destroy {tile.feature}")
        if tile.resource_type == "BONUS":
            warnings.append(f"Placing here will destroy bonus resource: {tile.resource}")

        # Allow civilization-specific validation (for subclasses)
        civ_result = self._validate_civilization_specific(district_type, x, y, tile, existing_placements)
        errors.extend(civ_result.errors)
        warnings.extend(civ_result.warnings)

        return PlacementResult(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
        )

    def _validate_aqueduct(
        self,
        x: int,
        y: int,
        existing_placements: Dict[Tuple[int, int], DistrictType],
    ) -> List[str]:
        """Validate Aqueduct placement rules."""
        errors = []
        tile = self.get_tile(x, y)

        # Must be adjacent to City Center
        if hex_distance(x, y, self.city_center[0], self.city_center[1]) != 1:
            errors.append("Aqueduct must be adjacent to City Center")
            return errors  # Can't check other rules without adjacency

        # Must be adjacent to fresh water source
        fresh_water_sources = []
        for nx, ny in get_neighbors(x, y):
            ntile = self.get_tile(nx, ny)
            if ntile is None:
                continue

            # Fresh water sources: Mountain, Lake, Oasis
            if ntile.is_mountain:
                fresh_water_sources.append(("Mountain", nx, ny))
            elif ntile.is_lake:
                fresh_water_sources.append(("Lake", nx, ny))
            elif ntile.feature == "FEATURE_OASIS":
                fresh_water_sources.append(("Oasis", nx, ny))
            # Adjacent river tile also provides fresh water
            elif ntile.has_river:
                fresh_water_sources.append(("River", nx, ny))

        # River on the Aqueduct tile itself also counts
        if tile.has_river:
            fresh_water_sources.append(("River", x, y))

        if not fresh_water_sources:
            errors.append("Aqueduct requires adjacent fresh water (Mountain, River, Lake, or Oasis)")

        # "No U-Turn" rule: fresh water cannot only be on the City Center edge
        if fresh_water_sources:
            cc_direction = get_direction_to_neighbor(x, y, self.city_center[0], self.city_center[1])
            cc_neighbor = (self.city_center[0], self.city_center[1])

            # Check if ALL fresh water is only from the CC direction
            non_cc_sources = [
                s for s in fresh_water_sources
                if (s[1], s[2]) != cc_neighbor and not (s[0] == "River" and cc_direction in tile.river_edges)
            ]

            if not non_cc_sources and fresh_water_sources:
                # Only source is toward CC - check if river is only on CC edge
                if len(fresh_water_sources) == 1 and fresh_water_sources[0][0] == "River":
                    if set(tile.river_edges) == {cc_direction}:
                        errors.append("Aqueduct 'No U-Turn' rule: Fresh water cannot only be on City Center edge")

        return errors

    def _validate_dam(
        self,
        x: int,
        y: int,
        existing_placements: Dict[Tuple[int, int], DistrictType],
    ) -> List[str]:
        """Validate Dam placement rules."""
        errors = []
        tile = self.get_tile(x, y)

        # Must be on Floodplains
        if not tile.is_floodplains:
            errors.append("Dam must be on Floodplains")
            return errors

        # River must traverse at least 2 edges of this hex
        if len(tile.river_edges) < 2:
            errors.append("Dam requires river to traverse at least 2 hex edges")

        return errors

    def _validate_canal(
        self,
        x: int,
        y: int,
        existing_placements: Dict[Tuple[int, int], DistrictType],
    ) -> List[str]:
        """Validate Canal placement rules.

        Official rule: The Canal must be built on flat land with a Coast or Lake
        tile on one side, and either a City Center or another body of water on
        the other side.

        This means Canal must:
        1. Be adjacent to at least one water body (Coast/Ocean/Lake)
        2. AND be adjacent to City Center OR another water body
        """
        errors = []

        # Find adjacent City Center and water tiles
        adjacent_city_center = False
        adjacent_water_tiles = []

        for nx, ny in get_neighbors(x, y):
            # Check if adjacent to City Center
            if (nx, ny) == self.city_center or existing_placements.get((nx, ny)) == DistrictType.CITY_CENTER:
                adjacent_city_center = True

            # Check for water tiles (Coast, Ocean, or Lake)
            ntile = self.get_tile(nx, ny)
            if ntile is not None and (ntile.is_water or ntile.is_lake):
                adjacent_water_tiles.append((nx, ny))

        # Must be adjacent to at least one water body
        if not adjacent_water_tiles:
            errors.append("Canal must be adjacent to at least one water body (Coast/Ocean/Lake)")
            return errors

        # Valid if: adjacent to City Center AND at least one water body
        if adjacent_city_center and len(adjacent_water_tiles) >= 1:
            return errors  # Valid: connects City Center to water

        # Valid if: connects two SEPARATE water bodies (not adjacent to each other)
        # If water tiles are adjacent, they're the same body - no canal needed
        if len(adjacent_water_tiles) >= 2:
            # Check if any pair of water tiles are NOT adjacent (separate bodies)
            for i, (wx1, wy1) in enumerate(adjacent_water_tiles):
                for wx2, wy2 in adjacent_water_tiles[i + 1:]:
                    if not is_adjacent(wx1, wy1, wx2, wy2):
                        return errors  # Valid: connects separate water bodies
            # All water tiles are adjacent to each other - same water body
            errors.append("Canal must connect separate water bodies (adjacent water tiles are the same body)")
            return errors

        # Invalid: only one water tile and no City Center adjacent
        errors.append("Canal must connect City Center to water OR connect two separate water bodies")

        return errors

    def _validate_civilization_specific(
        self,
        district_type: DistrictType,
        x: int,
        y: int,
        tile: Tile,
        existing_placements: Dict[Tuple[int, int], DistrictType],
    ) -> PlacementResult:
        """Hook for subclasses to add custom validation rules."""
        return PlacementResult(valid=True)


def get_placement_rules(
    tiles: Dict[Tuple[int, int], Tile],
    city_center: Tuple[int, int],
    population: int,
) -> PlacementRules:
    """Factory function to get placement rules."""
    return PlacementRules(tiles, city_center, population)
