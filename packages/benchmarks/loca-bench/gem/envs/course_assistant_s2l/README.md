# Course Assistant S2L Environment

This environment simulates a teaching assistant scenario where an AI agent needs to check student assignment submissions and send reminder emails.

## Task Overview

The agent plays the role of a teaching assistant for an NLP course who needs to:

1. **Check submission status**: Read emails to identify which students have submitted their presentations
2. **Identify missing submissions**: Find enrolled students who have not submitted
3. **Send personalized reminders**: Email each student who needs to submit with:
   - Subject: `nlp-course-emergency`
   - Content must include: student's name AND student ID

## Task Requirements

### What the Agent Should Do:
- ✅ Check the instructor's email inbox for student submissions (subject: `nlp-presentation-{student_id}-{name}`)
- ✅ Compare against the student roster in `nlp_statistics.xlsx`
- ✅ Identify enrolled students (status != "dropped") who have NOT submitted
- ✅ Send a personalized reminder email to EACH non-submitting student
- ✅ Include student name and ID in each reminder email

### What the Agent Should NOT Do:
- ❌ Send emails to students who already submitted
- ❌ Send emails to dropped students (status = "dropped")
- ❌ Send generic emails without student names/IDs

## Environment Structure

```
course_assistant_s2l/
├── course_assistant_s2l.py      # Main environment class
├── preprocess/
│   └── main.py                  # Preprocessing script
├── evaluation/
│   ├── check_local.py          # Evaluation logic
│   └── main.py                 # Evaluation entry point
├── initial_workspace/
│   ├── nlp_statistics.xlsx     # Template student roster
│   └── email_account.txt       # Template email credentials
├── generate_task_config.py     # Configuration generator
└── __init__.py
```

## Environment Parameters

- `task_dir` (str): Directory for task-related files
- `num_students` (int, default=15): Number of students to generate
- `dropout_rate` (float, default=0.1): Probability of student dropping (0-1)
- `submission_rate` (float, default=0.7): Probability of submission (0-1)
- `num_check` (int, default=2): Legacy parameter (kept for compatibility)
- `seed` (int, default=42): Random seed for reproducibility
- `verbose` (bool, default=False): Enable console logging

## Usage Example

```python
from gem.envs.course_assistant_s2l import CourseAssistantS2LEnv

# Create environment
env = CourseAssistantS2LEnv(
    task_dir="/path/to/task",
    num_students=20,
    dropout_rate=0.15,
    submission_rate=0.6,
    seed=42,
    verbose=True
)

# Reset environment (triggers preprocessing)
instruction, info = env.reset()

# Agent performs task...
# When done:
observation, reward, terminated, truncated, info = env.step("claim_done")

if info["success"]:
    print("Task completed successfully!")
else:
    print(f"Task failed: {info['error']}")
```

## Preprocessing Steps

When `reset()` is called, the environment:

1. **Generates task configuration**
   - Creates student roster with random names, IDs, and statuses
   - Generates email submissions from some students
   - Saves configuration files

2. **Initializes email database**
   - Creates email accounts for all students and instructors
   - Sets up inbox/sent folders

3. **Sends student submission emails**
   - Injects submission emails from students who submitted
   - Emails sent to instructor's inbox

4. **Prepares workspace**
   - Copies student roster and email credentials to agent workspace

## Evaluation Logic

When `step()` is called, the environment checks:

1. **All enrolled non-submitting students received emails**
   - Each student who is enrolled AND has not submitted gets exactly 1 email

2. **Email subject is correct**
   - Must be exactly: `nlp-course-emergency`

3. **Email content includes required information**
   - Must contain student's name
   - Must contain student's ID

4. **No incorrect emails sent**
   - Dropped students should NOT receive emails
   - Students who already submitted should NOT receive emails

## Files Generated During Task

### In `task_dir/`:
- `files/`
  - `students_info.json`: Complete student information with passwords
  - `emails.jsonl`: Submitted student emails
- `initial_workspace/`
  - `nlp_statistics.xlsx`: Student roster
  - `email_account.txt`: Instructor email credentials
- `agent_workspace/`
  - Copy of initial workspace files
- `local_db/`
  - `emails/`: Email database files
- `logs/`
  - `env.log`: Environment execution logs

## Notes

- The environment uses local JSON-based email database (no real SMTP/IMAP required)
- Each environment instance has isolated logging to support parallel execution
- Module loading uses `importlib` with unique identifiers to prevent naming conflicts in parallel runs
- Environment variables (`EMAIL_DATA_DIR`, `TASK_DIR`) are set to guide evaluation scripts

## Dependencies

- `openpyxl`: For Excel file handling
- `gem.core`: Base environment class
- `gem.tools.mcp_server`: Email database utilities
- `gem.utils.constants`: Environment constants

## Related Tasks

This environment is adapted from the `course-assistant-s2l` task in mcpbench_dev.



