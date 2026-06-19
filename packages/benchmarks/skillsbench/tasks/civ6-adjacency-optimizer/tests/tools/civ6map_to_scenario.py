#!/usr/bin/env python3
"""
Civ6Map to Scenario Converter
=============================

Converts WorldBuilder-exported .Civ6Map files (SQLite databases) to
scenario.json format for the civ6-optimizer task.

.Civ6Map files are SQLite databases. Plot coordinates are derived from
plot ID: x = ID % width, y = ID // width

Usage:
    python tools/civ6map_to_scenario.py map.Civ6Map -o scenario.json
    python tools/civ6map_to_scenario.py map.Civ6Map --population 7 --districts CAMPUS,HARBOR
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple


# Terrain mappings
TERRAIN_MAP = {
    "TERRAIN_COAST": "COAST",
    "TERRAIN_OCEAN": "OCEAN",
    "TERRAIN_GRASS": "GRASS",
    "TERRAIN_GRASS_HILLS": "GRASS",
    "TERRAIN_GRASS_MOUNTAIN": "MOUNTAIN",
    "TERRAIN_PLAINS": "PLAINS",
    "TERRAIN_PLAINS_HILLS": "PLAINS",
    "TERRAIN_PLAINS_MOUNTAIN": "MOUNTAIN",
    "TERRAIN_DESERT": "DESERT",
    "TERRAIN_DESERT_HILLS": "DESERT",
    "TERRAIN_DESERT_MOUNTAIN": "MOUNTAIN",
    "TERRAIN_TUNDRA": "TUNDRA",
    "TERRAIN_TUNDRA_HILLS": "TUNDRA",
    "TERRAIN_TUNDRA_MOUNTAIN": "MOUNTAIN",
    "TERRAIN_SNOW": "SNOW",
    "TERRAIN_SNOW_HILLS": "SNOW",
    "TERRAIN_SNOW_MOUNTAIN": "MOUNTAIN",
}

FEATURE_MAP = {
    "FEATURE_FOREST": "FEATURE_FOREST",
    "FEATURE_JUNGLE": "FEATURE_JUNGLE",
    "FEATURE_MARSH": "FEATURE_MARSH",
    "FEATURE_OASIS": "FEATURE_OASIS",
    "FEATURE_REEF": "FEATURE_REEF",
    "FEATURE_ICE": "FEATURE_ICE",
    "FEATURE_FLOODPLAINS": "FEATURE_FLOODPLAINS",
    "FEATURE_FLOODPLAINS_GRASSLAND": "FEATURE_FLOODPLAINS",
    "FEATURE_FLOODPLAINS_PLAINS": "FEATURE_FLOODPLAINS",
    "FEATURE_GEOTHERMAL_FISSURE": "FEATURE_GEOTHERMAL_FISSURE",
    "FEATURE_VOLCANIC_SOIL": "FEATURE_VOLCANIC_SOIL",
}

NATURAL_WONDERS = {
    "FEATURE_BARRIER_REEF", "FEATURE_CLIFFS_DOVER", "FEATURE_CRATER_LAKE",
    "FEATURE_DEAD_SEA", "FEATURE_EVEREST", "FEATURE_GALAPAGOS",
    "FEATURE_KILIMANJARO", "FEATURE_PANTANAL", "FEATURE_PIOPIOTAHI",
    "FEATURE_TORRES_DEL_PAINE", "FEATURE_TSINGY", "FEATURE_YOSEMITE",
    "FEATURE_ULURU", "FEATURE_DELICATE_ARCH", "FEATURE_EYE_OF_THE_SAHARA",
    "FEATURE_LAKE_RETBA", "FEATURE_MATTERHORN", "FEATURE_RORAIMA",
    "FEATURE_UBSUNUR_HOLLOW", "FEATURE_ZHANGYE_DANXIA", "FEATURE_HA_LONG_BAY",
    "FEATURE_EYJAFJALLAJOKULL", "FEATURE_LYSEFJORDEN", "FEATURE_GIANTS_CAUSEWAY",
}

RESOURCE_TYPE_MAP = {
    "RESOURCE_HORSES": "STRATEGIC", "RESOURCE_IRON": "STRATEGIC",
    "RESOURCE_NITER": "STRATEGIC", "RESOURCE_COAL": "STRATEGIC",
    "RESOURCE_OIL": "STRATEGIC", "RESOURCE_ALUMINUM": "STRATEGIC",
    "RESOURCE_URANIUM": "STRATEGIC",
    "RESOURCE_DIAMONDS": "LUXURY", "RESOURCE_PEARLS": "LUXURY",
    "RESOURCE_JADE": "LUXURY", "RESOURCE_MARBLE": "LUXURY",
    "RESOURCE_SILK": "LUXURY", "RESOURCE_SPICES": "LUXURY",
    "RESOURCE_SUGAR": "LUXURY", "RESOURCE_TEA": "LUXURY",
    "RESOURCE_TOBACCO": "LUXURY", "RESOURCE_WINE": "LUXURY",
    "RESOURCE_WHALES": "LUXURY", "RESOURCE_COTTON": "LUXURY",
    "RESOURCE_FISH": "BONUS", "RESOURCE_WHEAT": "BONUS",
    "RESOURCE_CATTLE": "BONUS", "RESOURCE_SHEEP": "BONUS",
    "RESOURCE_DEER": "BONUS", "RESOURCE_BANANAS": "BONUS",
    "RESOURCE_RICE": "BONUS", "RESOURCE_MAIZE": "BONUS",
    "RESOURCE_STONE": "BONUS", "RESOURCE_COPPER": "BONUS",
}

IMPROVEMENT_MAP = {
    "IMPROVEMENT_MINE": "MINE",
    "IMPROVEMENT_QUARRY": "QUARRY",
    "IMPROVEMENT_LUMBER_MILL": "LUMBER_MILL",
    "IMPROVEMENT_FARM": "FARM",
}


def id_to_coords(plot_id: int, width: int) -> Tuple[int, int]:
    """Convert plot ID to (x, y) coordinates."""
    return plot_id % width, plot_id // width


def convert_civ6map(db_path: str) -> Dict[str, Any]:
    """Convert a .Civ6Map SQLite database to scenario dict."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Get map dimensions
    cursor.execute("SELECT Width, Height FROM Map LIMIT 1")
    row = cursor.fetchone()
    if not row:
        raise ValueError("Could not read map dimensions")
    width, height = row["Width"], row["Height"]
    print(f"Map: {width} x {height}", file=sys.stderr)

    tiles: Dict[int, Dict[str, Any]] = {}

    # Get available columns
    cursor.execute("PRAGMA table_info(Plots)")
    columns = {col["name"] for col in cursor.fetchall()}

    # Query plots
    cursor.execute("SELECT * FROM Plots")
    for row in cursor.fetchall():
        plot_id = row["ID"]
        x, y = id_to_coords(plot_id, width)

        raw_terrain = row["TerrainType"] or ""
        terrain = TERRAIN_MAP.get(raw_terrain, raw_terrain.replace("TERRAIN_", ""))
        is_hills = "_HILLS" in raw_terrain

        tile: Dict[str, Any] = {"x": x, "y": y, "terrain": terrain}
        if is_hills:
            tile["is_hills"] = True

        # Features
        if "FeatureType" in columns and row["FeatureType"]:
            raw_feature = row["FeatureType"]
            if raw_feature in NATURAL_WONDERS:
                tile["feature"] = raw_feature
                tile["is_natural_wonder"] = True
            elif raw_feature in FEATURE_MAP:
                tile["feature"] = FEATURE_MAP[raw_feature]
            else:
                tile["feature"] = raw_feature
            if "FLOODPLAINS" in raw_feature:
                tile["is_floodplains"] = True

        tiles[plot_id] = tile

    print(f"Plots: {len(tiles)}", file=sys.stderr)

    # Features from PlotFeatures table (if exists)
    try:
        cursor.execute("SELECT * FROM PlotFeatures")
        feat_count = 0
        for row in cursor.fetchall():
            plot_id = row["PlotID"] if "PlotID" in dict(row).keys() else row["ID"]
            if plot_id in tiles and "feature" not in tiles[plot_id]:
                feature = row["FeatureType"]
                if feature in NATURAL_WONDERS:
                    tiles[plot_id]["feature"] = feature
                    tiles[plot_id]["is_natural_wonder"] = True
                elif feature in FEATURE_MAP:
                    tiles[plot_id]["feature"] = FEATURE_MAP[feature]
                else:
                    tiles[plot_id]["feature"] = feature
                # Set is_floodplains flag
                if "FLOODPLAINS" in feature:
                    tiles[plot_id]["is_floodplains"] = True
                feat_count += 1
        print(f"Features: {feat_count}", file=sys.stderr)
    except sqlite3.OperationalError:
        pass

    # Rivers
    # River edges are stored in two ways:
    # 1. Is*OfRiver flags: river on NE (edge 1), NW (edge 2), W (edge 3) edges
    # 2. FlowDirection values: river on E (edge 0), SW (edge 4), SE (edge 5) edges
    #    FlowDirection = -1 means no river, any other value means river present
    try:
        cursor.execute("SELECT * FROM PlotRivers")
        river_count = 0
        for row in cursor.fetchall():
            row_dict = dict(row)
            plot_id = row_dict.get("PlotID") or row_dict.get("ID")
            if plot_id not in tiles:
                continue
            river_edges = []
            # Check Is*OfRiver flags (edges 1, 2, 3)
            if row_dict.get("IsNEOfRiver"):
                river_edges.append(1)
            if row_dict.get("IsNWOfRiver"):
                river_edges.append(2)
            if row_dict.get("IsWOfRiver"):
                river_edges.append(3)
            # Check FlowDirection values (edges 0, 4, 5) - value != -1 means river present
            if row_dict.get("EFlowDirection", -1) != -1:
                river_edges.append(0)
            if row_dict.get("SWFlowDirection", -1) != -1:
                river_edges.append(4)
            if row_dict.get("SEFlowDirection", -1) != -1:
                river_edges.append(5)
            if river_edges:
                tiles[plot_id]["river_edges"] = sorted(river_edges)
                river_count += 1
        print(f"Rivers: {river_count} tiles", file=sys.stderr)
    except sqlite3.OperationalError:
        pass

    # Resources
    try:
        cursor.execute("SELECT * FROM PlotResources")
        res_count = 0
        for row in cursor.fetchall():
            plot_id = row["PlotID"] if "PlotID" in dict(row).keys() else row["ID"]
            if plot_id in tiles:
                resource = row["ResourceType"]
                tiles[plot_id]["resource"] = resource
                tiles[plot_id]["resource_type"] = RESOURCE_TYPE_MAP.get(resource, "BONUS")
                res_count += 1
        print(f"Resources: {res_count}", file=sys.stderr)
    except sqlite3.OperationalError:
        pass

    conn.close()

    tiles_list = sorted(tiles.values(), key=lambda t: (t["y"], t["x"]))
    return {"dimensions": {"width": width, "height": height}, "tiles": tiles_list}


def main():
    parser = argparse.ArgumentParser(description="Convert .Civ6Map to scenario JSON")
    parser.add_argument("map_file", help="Path to .Civ6Map file")
    parser.add_argument("-o", "--output", help="Output JSON file")
    parser.add_argument("--id", default="scenario_1", help="Scenario ID")
    parser.add_argument("--num-cities", type=int, default=1)
    parser.add_argument("--population", type=int, default=7)
    parser.add_argument("--civilization", default="GENERIC")
    parser.add_argument("--districts", help="(deprecated) Districts to include in solution")

    args = parser.parse_args()

    result = convert_civ6map(args.map_file)

    scenario = {
        "id": args.id,
        "description": f"Scenario from {Path(args.map_file).name}",
        "dimensions": result["dimensions"],
        "num_cities": args.num_cities,
        "population": args.population,
        "civilization": args.civilization,
        "tiles": result["tiles"],
    }

    output_json = json.dumps(scenario, indent=2)

    if args.output:
        with open(args.output, "w") as f:
            f.write(output_json)
        print(f"Saved: {args.output}", file=sys.stderr)
    else:
        print(output_json)


if __name__ == "__main__":
    main()
