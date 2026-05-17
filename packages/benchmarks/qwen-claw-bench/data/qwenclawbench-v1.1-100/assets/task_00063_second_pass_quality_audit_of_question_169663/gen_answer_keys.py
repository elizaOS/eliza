import csv
import random

random.seed(270825659)

# Generate answer_key_v1.csv (older version, matches question bank for 169663)
# and answer_key_v2.csv (newer version, contradicts for 169663)

# We need ~50 rows each. Include 169660-169670 plus surrounding questions.

def gen_answer_keys():
    question_ids = list(range(169600, 169650)) + list(range(169660, 169671))
    # Ensure we have ~50+ entries
    
    answer_choices = ["A", "B", "C", "D"]
    
    # Predefined answers for our batch
    batch_answers = {
        169660: ("B", "12"),
        169661: ("C", "84"),
        169662: ("A", "31.4"),
        169663: None,  # handled separately
        169664: ("C", "36"),
        169665: ("B", "623"),
        169666: ("C", "0.5"),
        169667: ("C", "900"),
        169668: ("B", "113.04"),
        169669: ("A", "1"),
        169670: ("C", "120"),
    }
    
    # V1 - older version
    rows_v1 = []
    for qid in question_ids:
        if qid == 169663:
            rows_v1.append({
                "question_id": qid,
                "correct_answer": "B",
                "correct_value": "33.85",
                "last_updated": "2024-10-15"
            })
        elif qid in batch_answers:
            ans, val = batch_answers[qid]
            rows_v1.append({
                "question_id": qid,
                "correct_answer": ans,
                "correct_value": val,
                "last_updated": "2024-10-15"
            })
        else:
            ans = random.choice(answer_choices)
            val = str(round(random.uniform(1, 500), 2))
            day = random.randint(1, 28)
            rows_v1.append({
                "question_id": qid,
                "correct_answer": ans,
                "correct_value": val,
                "last_updated": f"2024-10-{day:02d}"
            })
    
    with open("data/answer_key_v1.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["question_id", "correct_answer", "correct_value", "last_updated"])
        writer.writeheader()
        writer.writerows(rows_v1)
    
    # V2 - newer version (169663 changed to C)
    random.seed(270825659)  # reset for consistency on random entries
    rows_v2 = []
    for qid in question_ids:
        if qid == 169663:
            rows_v2.append({
                "question_id": qid,
                "correct_answer": "C",
                "correct_value": "31.85",
                "last_updated": "2024-12-01"
            })
        elif qid in batch_answers:
            ans, val = batch_answers[qid]
            rows_v2.append({
                "question_id": qid,
                "correct_answer": ans,
                "correct_value": val,
                "last_updated": "2024-12-01"
            })
        else:
            ans = random.choice(answer_choices)
            val = str(round(random.uniform(1, 500), 2))
            day = random.randint(1, 10)
            rows_v2.append({
                "question_id": qid,
                "correct_answer": ans,
                "correct_value": val,
                "last_updated": f"2024-12-{day:02d}"
            })
    
    with open("data/answer_key_v2.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["question_id", "correct_answer", "correct_value", "last_updated"])
        writer.writeheader()
        writer.writerows(rows_v2)
    
    print(f"V1: {len(rows_v1)} rows, V2: {len(rows_v2)} rows")

gen_answer_keys()
