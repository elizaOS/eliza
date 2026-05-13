import json
import random

random.seed(270825659)

auditors = ["auditor_01", "auditor_03", "auditor_05", "auditor_07", "auditor_09", "auditor_12"]

audit_results = []
for i, qid in enumerate(range(169660, 169671)):
    if qid == 169663:
        entry = {
            "question_id": 169663,
            "first_pass_result": "pass",
            "issues": [],
            "auditor": "auditor_07",
            "timestamp": "2024-11-15T09:32:00Z",
            "notes": "Question reviewed. SVG renders correctly. Options and answer verified."
        }
    else:
        auditor = random.choice(auditors)
        hour = 9 + (i % 4)
        minute = random.randint(10, 55)
        entry = {
            "question_id": qid,
            "first_pass_result": "pass",
            "issues": [],
            "auditor": auditor,
            "timestamp": f"2024-11-15T{hour:02d}:{minute:02d}:00Z",
            "notes": "No issues found during first-pass review."
        }
    audit_results.append(entry)

with open("data/first_pass_audit.json", "w", encoding="utf-8") as f:
    json.dump(audit_results, f, ensure_ascii=False, indent=2)

print(f"Generated {len(audit_results)} audit entries")
