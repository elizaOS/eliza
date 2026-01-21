#!/usr/bin/env python3
import json
from pathlib import Path


PERSONAS_DIR = Path("/Users/shawwalters/matching/data/personas")

FIRST_NAMES = [
    "Aaliyah",
    "Aiden",
    "Alex",
    "Amara",
    "Amir",
    "Ana",
    "Andre",
    "Ari",
    "Aria",
    "Asher",
    "Asha",
    "Avery",
    "Bailey",
    "Beatriz",
    "Ben",
    "Bianca",
    "Carlos",
    "Carmen",
    "Casey",
    "Celeste",
    "Cesar",
    "Chloe",
    "Chris",
    "Dalia",
    "Damon",
    "Daniel",
    "Dara",
    "Deepa",
    "Diego",
    "Eden",
    "Eli",
    "Elisa",
    "Emre",
    "Esme",
    "Farah",
    "Felix",
    "Fiona",
    "Gabe",
    "Hana",
    "Idris",
    "Imani",
    "Iris",
    "Jae",
    "Jalen",
    "Javier",
    "Jaya",
    "Jordan",
    "Jules",
    "Kai",
    "Kara",
    "Kian",
    "Laila",
    "Lana",
    "Leah",
    "Leo",
    "Lina",
    "Logan",
    "Lucia",
    "Luis",
    "Maya",
    "Micah",
    "Mina",
    "Nadia",
    "Nia",
    "Nico",
    "Noor",
    "Omar",
    "Priya",
    "Quinn",
    "Rafael",
    "Rhea",
    "Riley",
    "Rosa",
    "Sam",
    "Sana",
    "Sara",
    "Sofia",
    "Talia",
    "Theo",
    "Val",
    "Vera",
    "Wren",
    "Yara",
    "Zane",
    "Zoya",
]

LAST_NAMES = [
    "Ahmed",
    "Alvarez",
    "Anderson",
    "Arora",
    "Bennett",
    "Brooks",
    "Carter",
    "Chen",
    "Clarke",
    "Collins",
    "Costa",
    "Cruz",
    "Diaz",
    "Dubois",
    "Edwards",
    "Farouk",
    "Flores",
    "Foster",
    "Garcia",
    "Gomez",
    "Gonzalez",
    "Gupta",
    "Haddad",
    "Hassan",
    "Hill",
    "Howard",
    "Hughes",
    "Ibrahim",
    "Iyer",
    "Jackson",
    "Kapoor",
    "Khan",
    "Kim",
    "Kumar",
    "Lee",
    "Lewis",
    "Liu",
    "Lopez",
    "Martin",
    "Martinez",
    "Mensah",
    "Miller",
    "Moore",
    "Morgan",
    "Nguyen",
    "O'Neill",
    "Okoye",
    "Park",
    "Patel",
    "Perez",
    "Quinn",
    "Rahman",
    "Reed",
    "Rivera",
    "Rossi",
    "Santos",
    "Sato",
    "Shah",
    "Singh",
    "Stein",
    "Tanaka",
    "Thompson",
    "Tran",
    "Volkov",
    "Walker",
    "Ward",
    "White",
    "Williams",
    "Wright",
    "Wu",
    "Xu",
    "Young",
    "Yusuf",
    "Zhao",
]


def make_name(seed, used):
    first_idx = (seed * 7 + 3) % len(FIRST_NAMES)
    last_idx = (seed * 11 + 5) % len(LAST_NAMES)
    for step in range(len(LAST_NAMES)):
        candidate = f"{FIRST_NAMES[first_idx]} {LAST_NAMES[(last_idx + step) % len(LAST_NAMES)]}"
        if candidate not in used:
            used.add(candidate)
            return candidate
    candidate = f"{FIRST_NAMES[first_idx]} {LAST_NAMES[last_idx]}"
    used.add(candidate)
    return candidate


def update_persona(path, name_seed, used):
    data = json.loads(path.read_text(encoding="utf-8"))
    general = data.get("general")
    if not isinstance(general, dict):
        return
    old_name = general.get("name")
    if not isinstance(old_name, str):
        return

    new_name = make_name(name_seed, used)
    general["name"] = new_name

    conversations = data.get("conversations")
    if isinstance(conversations, list):
        for conv in conversations:
            if not isinstance(conv, dict):
                continue
            turns = conv.get("turns")
            if not isinstance(turns, list):
                continue
            for turn in turns:
                if not isinstance(turn, dict):
                    continue
                text = turn.get("text")
                if isinstance(text, str) and old_name in text:
                    turn["text"] = text.replace(old_name, new_name)

    facts = data.get("facts")
    if isinstance(facts, list):
        for fact in facts:
            if not isinstance(fact, dict):
                continue
            key = fact.get("key")
            if key == "name":
                fact["value"] = new_name
            else:
                val = fact.get("value")
                if isinstance(val, str) and val == old_name:
                    fact["value"] = new_name

    path.write_text(json.dumps(data, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def main():
    files = sorted(PERSONAS_DIR.glob("*.json"))
    used = set()
    for idx, path in enumerate(files):
        data = json.loads(path.read_text(encoding="utf-8"))
        domain = data.get("domain")
        general = data.get("general")
        city = None
        if isinstance(general, dict):
            loc = general.get("location")
            if isinstance(loc, dict):
                city = loc.get("city")

        domain_offset = 0 if domain == "dating" else 1000 if domain == "business" else 2000
        city_offset = 300 if city == "New York" else 0
        seed = idx + domain_offset + city_offset
        update_persona(path, seed, used)

    print(f"Updated names for {len(files)} personas")


if __name__ == "__main__":
    main()
