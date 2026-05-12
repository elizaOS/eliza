import csv
import random

random.seed(270825659)

topics_map = {
    "geometry": ["perimeter", "area", "composite_perimeter", "circle_properties", "triangle_properties", "parallelogram_area", "volume"],
    "arithmetic": ["addition", "subtraction", "multiplication", "division", "mixed_operations", "remainders"],
    "fractions": ["comparison", "addition", "subtraction", "multiplication", "equivalent_fractions"],
    "measurement": ["unit_conversion", "time", "weight", "length"],
    "data_analysis": ["bar_chart", "line_graph", "average", "mode"],
}

# Predefined entries for our batch
batch_entries = {
    169660: {"difficulty": 2, "topic": "geometry", "subtopic": "perimeter", "grade_level": 4},
    169661: {"difficulty": 2, "topic": "geometry", "subtopic": "area", "grade_level": 4},
    169662: {"difficulty": 3, "topic": "geometry", "subtopic": "circle_properties", "grade_level": 5},
    169663: {"difficulty": 3, "topic": "geometry", "subtopic": "composite_perimeter", "grade_level": 5},
    169664: {"difficulty": 1, "topic": "geometry", "subtopic": "perimeter", "grade_level": 3},
    169665: {"difficulty": 1, "topic": "arithmetic", "subtopic": "addition", "grade_level": 3},
    169666: {"difficulty": 3, "topic": "fractions", "subtopic": "comparison", "grade_level": 4},
    169667: {"difficulty": 2, "topic": "arithmetic", "subtopic": "multiplication", "grade_level": 4},
    169668: {"difficulty": 3, "topic": "geometry", "subtopic": "circle_properties", "grade_level": 5},
    169669: {"difficulty": 2, "topic": "arithmetic", "subtopic": "remainders", "grade_level": 3},
    169670: {"difficulty": 2, "topic": "geometry", "subtopic": "parallelogram_area", "grade_level": 5},
}

rows = []
all_qids = list(range(169600, 169700))

for qid in all_qids:
    if qid in batch_entries:
        entry = batch_entries[qid]
        rows.append({
            "question_id": qid,
            "difficulty": entry["difficulty"],
            "topic": entry["topic"],
            "subtopic": entry["subtopic"],
            "grade_level": entry["grade_level"]
        })
    else:
        topic = random.choice(list(topics_map.keys()))
        subtopic = random.choice(topics_map[topic])
        difficulty = random.randint(1, 5)
        grade = random.randint(3, 6)
        rows.append({
            "question_id": qid,
            "difficulty": difficulty,
            "topic": topic,
            "subtopic": subtopic,
            "grade_level": grade
        })

with open("data/difficulty_ratings.csv", "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=["question_id", "difficulty", "topic", "subtopic", "grade_level"])
    writer.writeheader()
    writer.writerows(rows)

print(f"Generated {len(rows)} difficulty rating entries")
