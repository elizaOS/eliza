"""
Diplomacy map data - provinces, adjacencies, and supply centers.
"""

from __future__ import annotations

from elizaos_atropos_diplomacy.types import Power, UnitType


# Province types
class ProvinceType:
    LAND = "LAND"
    WATER = "WATER"
    COASTAL = "COASTAL"


# Province definitions with type and coasts
PROVINCES: dict[str, dict[str, object]] = {
    # Austria-Hungary home centers
    "BUD": {"type": ProvinceType.LAND, "name": "Budapest"},
    "TRI": {"type": ProvinceType.COASTAL, "name": "Trieste"},
    "VIE": {"type": ProvinceType.LAND, "name": "Vienna"},

    # England home centers
    "EDI": {"type": ProvinceType.COASTAL, "name": "Edinburgh"},
    "LON": {"type": ProvinceType.COASTAL, "name": "London"},
    "LVP": {"type": ProvinceType.COASTAL, "name": "Liverpool"},

    # France home centers
    "BRE": {"type": ProvinceType.COASTAL, "name": "Brest"},
    "MAR": {"type": ProvinceType.COASTAL, "name": "Marseilles"},
    "PAR": {"type": ProvinceType.LAND, "name": "Paris"},

    # Germany home centers
    "BER": {"type": ProvinceType.COASTAL, "name": "Berlin"},
    "KIE": {"type": ProvinceType.COASTAL, "name": "Kiel"},
    "MUN": {"type": ProvinceType.LAND, "name": "Munich"},

    # Italy home centers
    "NAP": {"type": ProvinceType.COASTAL, "name": "Naples"},
    "ROM": {"type": ProvinceType.COASTAL, "name": "Rome"},
    "VEN": {"type": ProvinceType.COASTAL, "name": "Venice"},

    # Russia home centers
    "MOS": {"type": ProvinceType.LAND, "name": "Moscow"},
    "SEV": {"type": ProvinceType.COASTAL, "name": "Sevastopol"},
    "STP": {"type": ProvinceType.COASTAL, "name": "St. Petersburg", "coasts": ["NC", "SC"]},
    "WAR": {"type": ProvinceType.LAND, "name": "Warsaw"},

    # Turkey home centers
    "ANK": {"type": ProvinceType.COASTAL, "name": "Ankara"},
    "CON": {"type": ProvinceType.COASTAL, "name": "Constantinople"},
    "SMY": {"type": ProvinceType.COASTAL, "name": "Smyrna"},

    # Neutral supply centers
    "BEL": {"type": ProvinceType.COASTAL, "name": "Belgium"},
    "BUL": {"type": ProvinceType.COASTAL, "name": "Bulgaria", "coasts": ["EC", "SC"]},
    "DEN": {"type": ProvinceType.COASTAL, "name": "Denmark"},
    "GRE": {"type": ProvinceType.COASTAL, "name": "Greece"},
    "HOL": {"type": ProvinceType.COASTAL, "name": "Holland"},
    "NWY": {"type": ProvinceType.COASTAL, "name": "Norway"},
    "POR": {"type": ProvinceType.COASTAL, "name": "Portugal"},
    "RUM": {"type": ProvinceType.COASTAL, "name": "Rumania"},
    "SER": {"type": ProvinceType.LAND, "name": "Serbia"},
    "SPA": {"type": ProvinceType.COASTAL, "name": "Spain", "coasts": ["NC", "SC"]},
    "SWE": {"type": ProvinceType.COASTAL, "name": "Sweden"},
    "TUN": {"type": ProvinceType.COASTAL, "name": "Tunis"},

    # Non-supply center land provinces
    "ALB": {"type": ProvinceType.COASTAL, "name": "Albania"},
    "APU": {"type": ProvinceType.COASTAL, "name": "Apulia"},
    "ARM": {"type": ProvinceType.COASTAL, "name": "Armenia"},
    "BOH": {"type": ProvinceType.LAND, "name": "Bohemia"},
    "BUR": {"type": ProvinceType.LAND, "name": "Burgundy"},
    "CLY": {"type": ProvinceType.COASTAL, "name": "Clyde"},
    "FIN": {"type": ProvinceType.COASTAL, "name": "Finland"},
    "GAL": {"type": ProvinceType.LAND, "name": "Galicia"},
    "GAS": {"type": ProvinceType.COASTAL, "name": "Gascony"},
    "LVN": {"type": ProvinceType.COASTAL, "name": "Livonia"},
    "NAF": {"type": ProvinceType.COASTAL, "name": "North Africa"},
    "PIC": {"type": ProvinceType.COASTAL, "name": "Picardy"},
    "PIE": {"type": ProvinceType.COASTAL, "name": "Piedmont"},
    "PRU": {"type": ProvinceType.COASTAL, "name": "Prussia"},
    "RUH": {"type": ProvinceType.LAND, "name": "Ruhr"},
    "SIL": {"type": ProvinceType.LAND, "name": "Silesia"},
    "SYR": {"type": ProvinceType.COASTAL, "name": "Syria"},
    "TUS": {"type": ProvinceType.COASTAL, "name": "Tuscany"},
    "TYR": {"type": ProvinceType.LAND, "name": "Tyrolia"},
    "UKR": {"type": ProvinceType.LAND, "name": "Ukraine"},
    "WAL": {"type": ProvinceType.COASTAL, "name": "Wales"},
    "YOR": {"type": ProvinceType.COASTAL, "name": "Yorkshire"},

    # Sea provinces
    "ADR": {"type": ProvinceType.WATER, "name": "Adriatic Sea"},
    "AEG": {"type": ProvinceType.WATER, "name": "Aegean Sea"},
    "BAL": {"type": ProvinceType.WATER, "name": "Baltic Sea"},
    "BAR": {"type": ProvinceType.WATER, "name": "Barents Sea"},
    "BLA": {"type": ProvinceType.WATER, "name": "Black Sea"},
    "BOT": {"type": ProvinceType.WATER, "name": "Gulf of Bothnia"},
    "EAS": {"type": ProvinceType.WATER, "name": "Eastern Mediterranean"},
    "ENG": {"type": ProvinceType.WATER, "name": "English Channel"},
    "GOL": {"type": ProvinceType.WATER, "name": "Gulf of Lyon"},
    "HEL": {"type": ProvinceType.WATER, "name": "Heligoland Bight"},
    "ION": {"type": ProvinceType.WATER, "name": "Ionian Sea"},
    "IRI": {"type": ProvinceType.WATER, "name": "Irish Sea"},
    "MAO": {"type": ProvinceType.WATER, "name": "Mid-Atlantic Ocean"},
    "NAO": {"type": ProvinceType.WATER, "name": "North Atlantic Ocean"},
    "NTH": {"type": ProvinceType.WATER, "name": "North Sea"},
    "NWG": {"type": ProvinceType.WATER, "name": "Norwegian Sea"},
    "SKA": {"type": ProvinceType.WATER, "name": "Skagerrak"},
    "TYS": {"type": ProvinceType.WATER, "name": "Tyrrhenian Sea"},
    "WES": {"type": ProvinceType.WATER, "name": "Western Mediterranean"},
}

# Supply centers by power
SUPPLY_CENTERS: dict[Power | None, list[str]] = {
    Power.AUSTRIA: ["BUD", "TRI", "VIE"],
    Power.ENGLAND: ["EDI", "LON", "LVP"],
    Power.FRANCE: ["BRE", "MAR", "PAR"],
    Power.GERMANY: ["BER", "KIE", "MUN"],
    Power.ITALY: ["NAP", "ROM", "VEN"],
    Power.RUSSIA: ["MOS", "SEV", "STP", "WAR"],
    Power.TURKEY: ["ANK", "CON", "SMY"],
    None: ["BEL", "BUL", "DEN", "GRE", "HOL", "NWY", "POR", "RUM", "SER", "SPA", "SWE", "TUN"],
}

# Home centers for each power
HOME_CENTERS: dict[Power, list[str]] = {
    Power.AUSTRIA: ["BUD", "TRI", "VIE"],
    Power.ENGLAND: ["EDI", "LON", "LVP"],
    Power.FRANCE: ["BRE", "MAR", "PAR"],
    Power.GERMANY: ["BER", "KIE", "MUN"],
    Power.ITALY: ["NAP", "ROM", "VEN"],
    Power.RUSSIA: ["MOS", "SEV", "STP", "WAR"],
    Power.TURKEY: ["ANK", "CON", "SMY"],
}

# Starting units for each power
STARTING_UNITS: dict[Power, list[tuple[UnitType, str]]] = {
    Power.AUSTRIA: [
        (UnitType.ARMY, "BUD"),
        (UnitType.ARMY, "VIE"),
        (UnitType.FLEET, "TRI"),
    ],
    Power.ENGLAND: [
        (UnitType.FLEET, "EDI"),
        (UnitType.FLEET, "LON"),
        (UnitType.ARMY, "LVP"),
    ],
    Power.FRANCE: [
        (UnitType.FLEET, "BRE"),
        (UnitType.ARMY, "MAR"),
        (UnitType.ARMY, "PAR"),
    ],
    Power.GERMANY: [
        (UnitType.FLEET, "KIE"),
        (UnitType.ARMY, "BER"),
        (UnitType.ARMY, "MUN"),
    ],
    Power.ITALY: [
        (UnitType.FLEET, "NAP"),
        (UnitType.ARMY, "ROM"),
        (UnitType.ARMY, "VEN"),
    ],
    Power.RUSSIA: [
        (UnitType.ARMY, "MOS"),
        (UnitType.ARMY, "WAR"),
        (UnitType.FLEET, "SEV"),
        (UnitType.FLEET, "STP"),  # South coast
    ],
    Power.TURKEY: [
        (UnitType.FLEET, "ANK"),
        (UnitType.ARMY, "CON"),
        (UnitType.ARMY, "SMY"),
    ],
}

# Province adjacencies (simplified - for army and fleet separately)
ADJACENCIES: dict[str, dict[str, list[str]]] = {
    # Land adjacencies (for armies)
    "BUD": {"army": ["GAL", "RUM", "SER", "TRI", "VIE"], "fleet": []},
    "TRI": {"army": ["ALB", "BUD", "SER", "TYR", "VEN", "VIE"], "fleet": ["ADR", "ALB", "VEN"]},
    "VIE": {"army": ["BOH", "BUD", "GAL", "TRI", "TYR"], "fleet": []},

    "EDI": {"army": ["CLY", "LVP", "YOR"], "fleet": ["CLY", "NTH", "NWG", "YOR"]},
    "LON": {"army": ["WAL", "YOR"], "fleet": ["ENG", "NTH", "WAL", "YOR"]},
    "LVP": {"army": ["CLY", "EDI", "WAL", "YOR"], "fleet": ["CLY", "IRI", "NAO", "WAL"]},

    "BRE": {"army": ["GAS", "PAR", "PIC"], "fleet": ["ENG", "GAS", "MAO", "PIC"]},
    "MAR": {"army": ["BUR", "GAS", "PIE", "SPA"], "fleet": ["GOL", "PIE", "SPA"]},
    "PAR": {"army": ["BRE", "BUR", "GAS", "PIC"], "fleet": []},

    "BER": {"army": ["KIE", "MUN", "PRU", "SIL"], "fleet": ["BAL", "KIE", "PRU"]},
    "KIE": {"army": ["BER", "DEN", "HOL", "MUN", "RUH"], "fleet": ["BAL", "BER", "DEN", "HEL", "HOL"]},
    "MUN": {"army": ["BER", "BOH", "BUR", "KIE", "RUH", "SIL", "TYR"], "fleet": []},

    "NAP": {"army": ["APU", "ROM"], "fleet": ["APU", "ION", "ROM", "TYS"]},
    "ROM": {"army": ["APU", "NAP", "TUS", "VEN"], "fleet": ["NAP", "TUS", "TYS"]},
    "VEN": {"army": ["APU", "PIE", "ROM", "TRI", "TUS", "TYR"], "fleet": ["ADR", "APU", "TRI"]},

    "MOS": {"army": ["LVN", "SEV", "STP", "UKR", "WAR"], "fleet": []},
    "SEV": {"army": ["ARM", "MOS", "RUM", "UKR"], "fleet": ["ARM", "BLA", "RUM"]},
    "STP": {"army": ["FIN", "LVN", "MOS", "NWY"], "fleet": ["BAR", "BOT", "FIN", "LVN", "NWY"]},
    "WAR": {"army": ["GAL", "LVN", "MOS", "PRU", "SIL", "UKR"], "fleet": []},

    "ANK": {"army": ["ARM", "CON", "SMY"], "fleet": ["ARM", "BLA", "CON"]},
    "CON": {"army": ["ANK", "BUL", "SMY"], "fleet": ["AEG", "ANK", "BLA", "BUL"]},
    "SMY": {"army": ["ANK", "ARM", "CON", "SYR"], "fleet": ["AEG", "ARM", "CON", "EAS", "SYR"]},

    # Neutral and other provinces (simplified)
    "BEL": {"army": ["BUR", "HOL", "PIC", "RUH"], "fleet": ["ENG", "HOL", "NTH", "PIC"]},
    "BUL": {"army": ["CON", "GRE", "RUM", "SER"], "fleet": ["AEG", "BLA", "CON", "GRE", "RUM"]},
    "DEN": {"army": ["KIE", "SWE"], "fleet": ["BAL", "HEL", "KIE", "NTH", "SKA", "SWE"]},
    "GRE": {"army": ["ALB", "BUL", "SER"], "fleet": ["AEG", "ALB", "BUL", "ION"]},
    "HOL": {"army": ["BEL", "KIE", "RUH"], "fleet": ["BEL", "HEL", "KIE", "NTH"]},
    "NWY": {"army": ["FIN", "STP", "SWE"], "fleet": ["BAR", "NTH", "NWG", "SKA", "STP", "SWE"]},
    "POR": {"army": ["SPA"], "fleet": ["MAO", "SPA"]},
    "RUM": {"army": ["BUL", "BUD", "GAL", "SER", "SEV", "UKR"], "fleet": ["BLA", "BUL", "SEV"]},
    "SER": {"army": ["ALB", "BUD", "BUL", "GRE", "RUM", "TRI"], "fleet": []},
    "SPA": {"army": ["GAS", "MAR", "POR"], "fleet": ["GOL", "MAO", "MAR", "POR", "WES"]},
    "SWE": {"army": ["DEN", "FIN", "NWY"], "fleet": ["BAL", "BOT", "DEN", "FIN", "NWY", "SKA"]},
    "TUN": {"army": ["NAF"], "fleet": ["ION", "NAF", "TYS", "WES"]},
}


def get_province_type(province: str) -> str:
    """Get the type of a province."""
    return str(PROVINCES.get(province, {}).get("type", ProvinceType.LAND))


def is_supply_center(province: str) -> bool:
    """Check if a province is a supply center."""
    for centers in SUPPLY_CENTERS.values():
        if province in centers:
            return True
    return False


def get_home_power(province: str) -> Power | None:
    """Get the home power for a province, if any."""
    for power, centers in HOME_CENTERS.items():
        if province in centers:
            return power
    return None


def get_adjacent_provinces(province: str, unit_type: UnitType) -> list[str]:
    """Get provinces adjacent to a given province for a unit type."""
    adj = ADJACENCIES.get(province, {})
    if unit_type == UnitType.ARMY:
        return adj.get("army", [])
    else:
        return adj.get("fleet", [])
