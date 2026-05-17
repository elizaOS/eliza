"""District adjacency bonus calculations for Civ6 (Gathering Storm).

This module calculates adjacency bonuses based on wiki-verified rules.

Reference: https://civilization.fandom.com/wiki/Adjacency_bonus_(Civ6)

CRITICAL RULES:
===============
1. Minor bonuses (+1 per 2) are counted SEPARATELY by type, then EACH floored.
   Example: 1 Mine + 1 Lumber Mill + 1 District for Industrial Zone
   - Mine: floor(1/2) = 0
   - Lumber Mill: floor(1/2) = 0
   - District: floor(1/2) = 0
   - TOTAL = 0 (NOT 1!)

2. Placing a district DESTROYS: Woods, Rainforest, Marsh, Bonus Resources
   This affects adjacency for OTHER districts!

3. Final bonus is always an INTEGER (floored).
"""

from dataclasses import dataclass, field
from typing import Dict, List, Set, Tuple, Optional, Any

from hex_utils import get_neighbors
from placement_rules import Tile, DistrictType


@dataclass
class AdjacencyRule:
    """Defines a single adjacency bonus rule.

    Attributes:
        sources: What provides this bonus (feature/terrain/district names)
        bonus_per: How much bonus per count_required matches
        count_required: How many matches needed for one bonus (1 = each, 2 = per 2)
    """
    sources: List[str]
    bonus_per: int
    count_required: int = 1


@dataclass
class AdjacencyResult:
    """Result of adjacency calculation for a single district."""
    total_bonus: int  # Always integer (floored)
    breakdown: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    # breakdown format: {"RULE_KEY": {"count": N, "bonus": B, "sources": [...]}}


# ============================================================================
# ADJACENCY RULES BY DISTRICT (Gathering Storm)
# ============================================================================

CAMPUS_RULES = [
    # +2 each
    AdjacencyRule(["FEATURE_GEOTHERMAL_FISSURE"], bonus_per=2, count_required=1),
    AdjacencyRule(["FEATURE_REEF"], bonus_per=2, count_required=1),
    AdjacencyRule(["GREAT_BARRIER_REEF"], bonus_per=2, count_required=1),  # Natural wonder
    # +1 each
    AdjacencyRule(["MOUNTAIN"], bonus_per=1, count_required=1),
    AdjacencyRule(["GOVERNMENT_PLAZA"], bonus_per=1, count_required=1),
    # +1 per 2 - SEPARATE counting for each type!
    AdjacencyRule(["FEATURE_JUNGLE"], bonus_per=1, count_required=2),  # Rainforest
    AdjacencyRule(["DISTRICT"], bonus_per=1, count_required=2),  # Generic district
]

HOLY_SITE_RULES = [
    # +2 each natural wonder
    AdjacencyRule(["NATURAL_WONDER"], bonus_per=2, count_required=1),
    # +1 each mountain
    AdjacencyRule(["MOUNTAIN"], bonus_per=1, count_required=1),
    AdjacencyRule(["GOVERNMENT_PLAZA"], bonus_per=1, count_required=1),
    # +1 per 2 - SEPARATE counting!
    AdjacencyRule(["FEATURE_FOREST"], bonus_per=1, count_required=2),  # Woods
    AdjacencyRule(["DISTRICT"], bonus_per=1, count_required=2),
]

THEATER_SQUARE_RULES = [
    # +2 each built wonder
    AdjacencyRule(["WONDER"], bonus_per=2, count_required=1),
    # +2 each Entertainment Complex or Water Park
    AdjacencyRule(["ENTERTAINMENT_COMPLEX", "WATER_PARK"], bonus_per=2, count_required=1),
    # +1 each Government Plaza
    AdjacencyRule(["GOVERNMENT_PLAZA"], bonus_per=1, count_required=1),
    # +1 per 2 districts
    AdjacencyRule(["DISTRICT"], bonus_per=1, count_required=2),
]

COMMERCIAL_HUB_RULES = [
    # +2 each adjacent Harbor
    AdjacencyRule(["HARBOR"], bonus_per=2, count_required=1),
    # +2 if ON river (special - not per adjacent, handled separately)
    # +1 each Government Plaza
    AdjacencyRule(["GOVERNMENT_PLAZA"], bonus_per=1, count_required=1),
    # +1 per 2 districts
    AdjacencyRule(["DISTRICT"], bonus_per=1, count_required=2),
]

HARBOR_RULES = [
    # +2 adjacent City Center
    AdjacencyRule(["CITY_CENTER"], bonus_per=2, count_required=1),
    # +1 each coastal resource
    AdjacencyRule(["COASTAL_RESOURCE"], bonus_per=1, count_required=1),
    AdjacencyRule(["GOVERNMENT_PLAZA"], bonus_per=1, count_required=1),
    # +1 per 2 districts
    AdjacencyRule(["DISTRICT"], bonus_per=1, count_required=2),
]

INDUSTRIAL_ZONE_RULES = [
    # +2 each Aqueduct, Bath, Canal, Dam
    AdjacencyRule(["AQUEDUCT", "BATH", "DAM", "CANAL"], bonus_per=2, count_required=1),
    # +1 each Quarry
    AdjacencyRule(["QUARRY"], bonus_per=1, count_required=1),
    # +1 each Strategic Resource
    AdjacencyRule(["STRATEGIC_RESOURCE"], bonus_per=1, count_required=1),
    AdjacencyRule(["GOVERNMENT_PLAZA"], bonus_per=1, count_required=1),
    # +1 per 2 - EACH type counted SEPARATELY then floored!
    AdjacencyRule(["MINE"], bonus_per=1, count_required=2),
    AdjacencyRule(["LUMBER_MILL"], bonus_per=1, count_required=2),
    AdjacencyRule(["DISTRICT"], bonus_per=1, count_required=2),
]

# Master registry
DISTRICT_ADJACENCY_RULES: Dict[DistrictType, List[AdjacencyRule]] = {
    DistrictType.CAMPUS: CAMPUS_RULES,
    DistrictType.HOLY_SITE: HOLY_SITE_RULES,
    DistrictType.THEATER_SQUARE: THEATER_SQUARE_RULES,
    DistrictType.COMMERCIAL_HUB: COMMERCIAL_HUB_RULES,
    DistrictType.HARBOR: HARBOR_RULES,
    DistrictType.INDUSTRIAL_ZONE: INDUSTRIAL_ZONE_RULES,
}

# Districts that count for the generic "DISTRICT" adjacency bonus
# ALL districts count for adjacency, including City Center, Aqueduct, etc.
# The distinction from NON_SPECIALTY (for population limit) is DIFFERENT
DISTRICTS_FOR_ADJACENCY: Set[DistrictType] = {
    # Specialty districts (count towards pop limit)
    DistrictType.CAMPUS,
    DistrictType.HOLY_SITE,
    DistrictType.THEATER_SQUARE,
    DistrictType.COMMERCIAL_HUB,
    DistrictType.HARBOR,
    DistrictType.INDUSTRIAL_ZONE,
    DistrictType.GOVERNMENT_PLAZA,
    DistrictType.ENTERTAINMENT_COMPLEX,
    DistrictType.WATER_PARK,
    DistrictType.ENCAMPMENT,
    DistrictType.AERODROME,
    DistrictType.PRESERVE,
    DistrictType.DIPLOMATIC_QUARTER,
    # Non-specialty districts (don't count towards pop limit, but DO count for adjacency!)
    DistrictType.CITY_CENTER,
    DistrictType.AQUEDUCT,
    DistrictType.DAM,
    DistrictType.CANAL,
    DistrictType.NEIGHBORHOOD,
    DistrictType.SPACEPORT,
}

# Note: Major and minor bonuses are ADDITIVE in Civ6!
# An Industrial Zone adjacent to an Aqueduct gets BOTH +2 (major) AND
# the Aqueduct counts toward the +1 per 2 districts (minor).

# Keep old name for backwards compatibility (but it's now ALL districts)
SPECIALTY_DISTRICTS = DISTRICTS_FOR_ADJACENCY

# Features destroyed when placing a district
DESTRUCTIBLE_FEATURES: Set[str] = {
    "FEATURE_FOREST",   # Woods
    "FEATURE_JUNGLE",   # Rainforest
    "FEATURE_MARSH",    # Marsh
}


# ============================================================================
# ADJACENCY CALCULATOR
# ============================================================================

class AdjacencyCalculator:
    """Calculates adjacency bonuses for districts."""

    def __init__(
        self,
        tiles: Dict[Tuple[int, int], Tile],
    ):
        self.tiles = tiles

    def get_tile(self, x: int, y: int) -> Optional[Tile]:
        return self.tiles.get((x, y))

    def apply_destruction(
        self,
        placements: Dict[Tuple[int, int], DistrictType],
    ) -> Dict[Tuple[int, int], Tile]:
        """
        Create modified tile dict with features/resources destroyed by placements.

        When a district is placed on a tile:
        - Woods, Rainforest, Marsh are destroyed
        - Bonus resources are destroyed

        EXCEPTION: City Center does NOT destroy features or resources!
        - Settling on geothermal fissure keeps it for adjacency
        - Settling on resources keeps them

        Returns:
            New tiles dict with modifications applied
        """
        modified = {}

        for coord, tile in self.tiles.items():
            if coord in placements:
                district_type = placements[coord]

                # City Center does NOT destroy features or resources
                if district_type == DistrictType.CITY_CENTER:
                    modified[coord] = tile  # Keep tile unchanged
                else:
                    # Other districts destroy certain features and bonus resources
                    modified[coord] = Tile(
                        x=tile.x,
                        y=tile.y,
                        terrain=tile.terrain,
                        feature=None if tile.feature in DESTRUCTIBLE_FEATURES else tile.feature,
                        is_hills=tile.is_hills,
                        is_floodplains=tile.is_floodplains,
                        river_edges=list(tile.river_edges),
                        river_names=list(tile.river_names),
                        resource=None if tile.resource_type == "BONUS" else tile.resource,
                        resource_type=None if tile.resource_type == "BONUS" else tile.resource_type,
                        improvement=None,  # District replaces improvement
                    )
            else:
                modified[coord] = tile

        return modified

    def count_rule_sources(
        self,
        x: int,
        y: int,
        rule: AdjacencyRule,
        tiles: Dict[Tuple[int, int], Tile],
        placements: Dict[Tuple[int, int], DistrictType],
    ) -> Tuple[int, List[str]]:
        """
        Count how many sources match a rule for a district at (x, y).

        Returns:
            (count, list of source descriptions)
        """
        count = 0
        sources: List[str] = []

        for nx, ny in get_neighbors(x, y):
            ntile = tiles.get((nx, ny))
            if ntile is None:
                continue

            for source_type in rule.sources:
                matched = False

                # Mountain
                if source_type == "MOUNTAIN" and ntile.is_mountain:
                    count += 1
                    sources.append(f"Mountain@({nx},{ny})")
                    matched = True

                # Natural Wonder
                elif source_type == "NATURAL_WONDER" and ntile.is_natural_wonder:
                    count += 1
                    sources.append(f"NaturalWonder@({nx},{ny})")
                    matched = True

                # Specific natural wonders
                elif ntile.feature and source_type in ntile.feature:
                    count += 1
                    sources.append(f"{source_type}@({nx},{ny})")
                    matched = True

                # Features (Woods, Rainforest, Reef, etc.)
                elif ntile.feature and ntile.feature == source_type:
                    count += 1
                    sources.append(f"{source_type}@({nx},{ny})")
                    matched = True

                # Improvements (Mine, Quarry, Lumber Mill)
                elif ntile.improvement and ntile.improvement.upper() == source_type:
                    count += 1
                    sources.append(f"{source_type}@({nx},{ny})")
                    matched = True

                # Strategic Resources
                elif source_type == "STRATEGIC_RESOURCE" and ntile.resource_type == "STRATEGIC":
                    count += 1
                    sources.append(f"Strategic({ntile.resource})@({nx},{ny})")
                    matched = True

                # Coastal Resources (for Harbor)
                elif source_type == "COASTAL_RESOURCE":
                    if ntile.is_water and ntile.resource:
                        count += 1
                        sources.append(f"CoastalResource({ntile.resource})@({nx},{ny})")
                        matched = True

                # Adjacent districts
                elif (nx, ny) in placements:
                    adj_district = placements[(nx, ny)]

                    # Specific district type match
                    if source_type == adj_district.name or source_type == adj_district.name.upper():
                        count += 1
                        sources.append(f"{adj_district.name}@({nx},{ny})")
                        matched = True

                    # Entertainment Complex / Water Park
                    elif source_type == "ENTERTAINMENT_COMPLEX" and adj_district == DistrictType.ENTERTAINMENT_COMPLEX:
                        count += 1
                        sources.append(f"EntertainmentComplex@({nx},{ny})")
                        matched = True
                    elif source_type == "WATER_PARK" and adj_district == DistrictType.WATER_PARK:
                        count += 1
                        sources.append(f"WaterPark@({nx},{ny})")
                        matched = True

                    # Infrastructure districts
                    elif source_type == "AQUEDUCT" and adj_district == DistrictType.AQUEDUCT:
                        count += 1
                        sources.append(f"Aqueduct@({nx},{ny})")
                        matched = True
                    elif source_type == "DAM" and adj_district == DistrictType.DAM:
                        count += 1
                        sources.append(f"Dam@({nx},{ny})")
                        matched = True
                    elif source_type == "CANAL" and adj_district == DistrictType.CANAL:
                        count += 1
                        sources.append(f"Canal@({nx},{ny})")
                        matched = True

                    # City Center
                    elif source_type == "CITY_CENTER" and adj_district == DistrictType.CITY_CENTER:
                        count += 1
                        sources.append(f"CityCenter@({nx},{ny})")
                        matched = True

                    # Harbor
                    elif source_type == "HARBOR" and adj_district == DistrictType.HARBOR:
                        count += 1
                        sources.append(f"Harbor@({nx},{ny})")
                        matched = True

                    # Government Plaza
                    elif source_type == "GOVERNMENT_PLAZA" and adj_district == DistrictType.GOVERNMENT_PLAZA:
                        count += 1
                        sources.append(f"GovernmentPlaza@({nx},{ny})")
                        matched = True

                    # Generic DISTRICT bonus
                    # Note: Major and minor bonuses are ADDITIVE - districts that give
                    # major bonuses (e.g., Aqueduct for IZ) ALSO count for minor bonus
                    elif source_type == "DISTRICT" and adj_district in SPECIALTY_DISTRICTS:
                        count += 1
                        sources.append(f"District({adj_district.name})@({nx},{ny})")
                        matched = True

                if matched:
                    break  # Only count each neighbor once per rule

        return count, sources

    def calculate_district_adjacency(
        self,
        district_type: DistrictType,
        x: int,
        y: int,
        tiles: Dict[Tuple[int, int], Tile],
        placements: Dict[Tuple[int, int], DistrictType],
    ) -> AdjacencyResult:
        """
        Calculate adjacency bonus for a single district.

        Args:
            district_type: Type of district
            x, y: District position
            tiles: Tile dict (should have destruction already applied)
            placements: All placements including city center

        Returns:
            AdjacencyResult with total bonus and breakdown
        """
        rules = self.get_rules_for_district(district_type)
        if not rules:
            return AdjacencyResult(total_bonus=0)

        tile = tiles.get((x, y))
        if tile is None:
            return AdjacencyResult(total_bonus=0)

        total = 0
        breakdown: Dict[str, Dict[str, Any]] = {}

        # Special: Commercial Hub river bonus (+2 if ON river)
        if district_type == DistrictType.COMMERCIAL_HUB and tile.has_river:
            total += 2
            breakdown["RIVER"] = {"count": 1, "bonus": 2, "sources": ["OnRiver"]}

        # Process each rule
        for rule in rules:
            count, sources = self.count_rule_sources(x, y, rule, tiles, placements)

            if count == 0:
                continue

            # Calculate bonus based on count_required
            if rule.count_required == 1:
                bonus = count * rule.bonus_per
            else:
                # +N per count_required (FLOORED!)
                bonus = (count // rule.count_required) * rule.bonus_per

            if bonus > 0:
                rule_key = "+".join(rule.sources)
                breakdown[rule_key] = {
                    "count": count,
                    "bonus": bonus,
                    "count_required": rule.count_required,
                    "bonus_per": rule.bonus_per,
                    "sources": sources,
                }
                total += bonus

        return AdjacencyResult(total_bonus=total, breakdown=breakdown)

    def get_rules_for_district(self, district_type: DistrictType) -> List[AdjacencyRule]:
        """Get adjacency rules for a district type."""
        return DISTRICT_ADJACENCY_RULES.get(district_type, [])

    def calculate_total_adjacency(
        self,
        placements: Dict[Tuple[int, int], DistrictType],
    ) -> Tuple[int, Dict[str, AdjacencyResult]]:
        """
        Calculate total adjacency for all placed districts.

        Applies destruction first, then calculates adjacency.

        Returns:
            (total_adjacency, per_district_results)
        """
        # Apply destruction from placements
        modified_tiles = self.apply_destruction(placements)

        total = 0
        per_district: Dict[str, AdjacencyResult] = {}

        for (x, y), district_type in placements.items():
            if district_type == DistrictType.CITY_CENTER:
                continue

            result = self.calculate_district_adjacency(
                district_type, x, y, modified_tiles, placements
            )
            total += result.total_bonus
            per_district[f"{district_type.name}@({x},{y})"] = result

        return total, per_district


def get_adjacency_calculator(
    tiles: Dict[Tuple[int, int], Tile],
) -> AdjacencyCalculator:
    """Factory function to get adjacency calculator."""
    return AdjacencyCalculator(tiles)
