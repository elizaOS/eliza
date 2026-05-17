# Academic Warning S2L Environment

This environment simulates an educational scenario where an agent needs to identify students at risk of academic failure by analyzing their exam performance.

## Task Description

The agent receives:
- **Historical exam data**: Multiple tables in BigQuery (`exam_2501` to `exam_2507`) containing historical exam scores
- **Latest quiz scores**: A CSV file (`latest_quiz_scores.csv`) in the workspace

The agent must:
1. Query all historical exam tables from BigQuery dataset `academic_warning`
2. Calculate the average historical score for each student (must have ≥3 historical records)
3. Compare latest quiz score with historical average
4. Identify students with >25% score drop
5. Save these students to `bad_student.csv` with columns: student_id, name, score, hist_avg, drop_ratio
6. For students with >45% drop, write CRITICAL level logs to Google Cloud Logging (log name: "exam_log")

## Environment Parameters

```python
AcademicWarningS2LEnv(
    task_dir: str,              # Directory for task-related files
    num_students: int = 150,    # Number of students to generate
    num_exams: int = 7,         # Number of historical exams
    difficulty: str = "medium", # Difficulty level: easy/medium/hard
    seed: int = 42,            # Random seed for reproducibility
    verbose: bool = False      # Console output
)
```

### Difficulty Levels

- **Easy**: 15% students with drops, 25% critical ratio, 25%-50% drop range
- **Medium**: 20% students with drops, 30% critical ratio, 25%-55% drop range  
- **Hard**: 30% students with drops, 40% critical ratio, 25%-65% drop range

## Directory Structure

```
task_dir/
├── agent_workspace/           # Agent's working directory
│   └── latest_quiz_scores.csv # Latest quiz scores
├── local_db/
│   └── google_cloud/         # Local Google Cloud database
├── files/                    # Generated historical exam CSV files
│   ├── scores_2501.csv
│   ├── scores_2502.csv
│   └── ...
├── initial_workspace/        # Initial workspace template
│   └── latest_quiz_scores.csv
├── groundtruth_workspace/    # Evaluation groundtruth
│   └── expected_alerts.csv
└── logs/                     # Environment logs
    └── env.log
```

## Evaluation Criteria

The agent's output is evaluated on:

1. **Student Identification (100% accuracy required)**
   - `bad_student.csv` must contain exactly the students with >25% drop
   - No false positives, no false negatives

2. **Critical Logging (100% completeness required)**
   - All students with >45% drop must have CRITICAL log entries
   - Log entries must include student ID, name, and drop ratio
   - No logs for students below 45% threshold

## Expected Output Format

### bad_student.csv
```csv
student_id,name,score,hist_avg,drop_ratio
S001,John Smith,45.2,68.5,0.340
S002,Jane Doe,38.7,72.1,0.463
```

### Cloud Logging (for >45% drops)
```json
{
  "severity": "CRITICAL",
  "logName": "exam_log",
  "textPayload": "ALERT: Student S002 (Jane Doe) score dropped 46.3%"
}
```

## Usage Example

```python
from gem.envs.academic_warning_s2l import AcademicWarningS2LEnv

# Create environment
env = AcademicWarningS2LEnv(
    task_dir="/path/to/task",
    num_students=150,
    num_exams=7,
    difficulty="medium",
    seed=42
)

# Reset environment (generates data and initializes)
instruction, info = env.reset()

# Agent performs task...
# agent_action = agent.act(instruction)

# Evaluate agent's work
observation, reward, terminated, truncated, info = env.step(action)
```

## Implementation Notes

- Uses local Google Cloud database simulation (no actual GCP required)
- Each environment instance uses unique module names to prevent conflicts
- All generated files are stored in task-specific directories
- Supports parallel execution of multiple environment instances
- Preprocessing generates fresh data on each reset

## File Dependencies

- `preprocess/main.py`: Data generation and database setup
- `evaluation/main.py`: Student identification and logging validation
- `generate_academic_data.py`: Synthetic student data generator

## Success Criteria

- **Minimum Accuracy**: 100% (exact match required for student identification)
- **Minimum Completeness**: 100% (all critical students must have logs)
- **Data Validation**: Students must have ≥3 historical records for inclusion

