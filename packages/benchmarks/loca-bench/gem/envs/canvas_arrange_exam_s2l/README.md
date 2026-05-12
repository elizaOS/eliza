# Canvas Arrange Exam S2L Environment

A Canvas LMS environment where agents need to organize exam schedule information from Canvas announcements and emails into an Excel spreadsheet.

## Overview

This environment simulates a realistic student scenario where exam information is distributed through multiple channels (Canvas announcements and emails). The agent must:

1. **Gather Information**: Extract exam details from Canvas course announcements and email notifications
2. **Organize Data**: Fill in an Excel spreadsheet with 11 required columns
3. **Sort Properly**: Order exams chronologically (earliest first, TBD exams last)
4. **Handle Complexity**: Deal with TBD dates, distraction emails/announcements, and multiple information sources

## Task Description

**Goal**: Complete the `exam_schedule.xlsx` file in the agent workspace with all exam information.

**Required Excel Columns**:
1. Course Code (e.g., CS101)
2. Course Name (e.g., Introduction to Computer Science)
3. Proctor Name (e.g., Debra)
4. Proctor Email (e.g., debra_flores76@mcp.com)
5. Open-book/Closed-book
6. Final Date (MM/DD/YYYY format)
7. Start Time (HH:MM format)
8. Duration (minutes)
9. Location
10. Information Source (Announcement/Email/Message)
11. Course Credit

**Sorting Rules**:
- Exams sorted by date and time (earliest first)
- TBD exams placed at the end
- For same datetime, sort by course code alphabetically

## Environment Parameters

### Basic Parameters
```python
env = CanvasArrangeExamS2LEnv(
    task_dir="/path/to/task",      # Directory for task files
    num_courses=10,                 # Number of courses (1-20)
    difficulty="medium",            # Difficulty level
    seed=42,                        # Random seed
    verbose=True                    # Enable console output
)
```

### Difficulty Levels

| Difficulty | Courses | Canvas Rate | Email Rate | TBD Rate | Distraction Emails |
|-----------|---------|-------------|------------|----------|-------------------|
| Easy      | 5       | 80%         | 20%        | 0%       | 0                 |
| Medium    | 10      | 70%         | 20%        | 20%      | 3                 |
| Hard      | 15      | 60%         | 30%        | 30%      | 5                 |
| Expert    | 20      | 50%         | 40%        | 40%      | 10                |

### Advanced Parameters
```python
env = CanvasArrangeExamS2LEnv(
    canvas_exam_rate=0.7,           # Rate of Canvas announcements
    email_exam_rate=0.2,            # Rate of email notifications
    no_exam_rate=0.1,               # Rate of no final exam
    tbd_rate=0.2,                   # Rate of TBD exam info
    past_exam_rate=0.15,            # Rate of past exams
    distraction_emails=3,           # Number of distraction emails
    distraction_announcements=2,    # Distraction announcements per course
)
```

## Usage Example

### Basic Usage
```python
from gem.envs.canvas_arrange_exam_s2l import CanvasArrangeExamS2LEnv

# Initialize environment
env = CanvasArrangeExamS2LEnv(
    task_dir="/tmp/canvas_exam_task",
    difficulty="medium",
    seed=42
)

# Get initial instruction
instruction, info = env.reset()
print(instruction)

# Agent works on the task...
# ... fills in exam_schedule.xlsx ...

# Evaluate result
observation, reward, terminated, truncated, info = env.step("claim_done")
print(f"Success: {info['success']}")
print(f"Reward: {reward}")
```

### Custom Configuration
```python
# Create environment with custom parameters
env = CanvasArrangeExamS2LEnv(
    task_dir="/tmp/custom_exam_task",
    num_courses=15,
    canvas_exam_rate=0.6,
    email_exam_rate=0.3,
    tbd_rate=0.25,
    distraction_emails=5,
    seed=100,
    verbose=True
)

instruction, info = env.reset()
```

## File Structure

After initialization, the environment creates:

```
task_dir/
├── agent_workspace/          # Agent's working directory
│   ├── exam_schedule.xlsx   # Excel file to fill (initial template)
│   └── memory/
│       └── memory.json      # Student profile information
├── groundtruth_workspace/   # Evaluation reference
│   ├── exam_schedule.xlsx   # Correct answer
│   └── metadata.json        # Task metadata
├── files/                   # Configuration files
│   ├── course_config.json   # Canvas course data
│   ├── email_config.json    # Email notification data
│   ├── canvas_users.json    # User data
│   └── exam_notification_template.txt
├── local_db/                # Local Canvas/Email database
│   ├── canvas/
│   └── emails/
└── logs/
    └── env.log             # Environment logs
```

## Evaluation Criteria

The environment checks:

1. **File Existence**: `exam_schedule.xlsx` must exist
2. **Column Integrity**: All 11 required columns present
3. **Time Ordering**: Exams sorted chronologically, TBD at end
4. **Content Accuracy**: All fields match groundtruth
5. **Format Compliance**: Correct date/time formats

**Success**: All checks pass (reward = 1.0)
**Failure**: Any check fails (reward = 0.0)

## Key Features

### 1. Multiple Information Sources
- **Canvas Announcements**: Final exam details in course announcements
- **Email Notifications**: Exam details sent via email
- **Mixed Distribution**: Some courses use announcements, others use emails

### 2. Realistic Complexity
- **TBD Information**: Some exam details not yet determined
- **Distraction Emails**: Irrelevant emails (shopping, social media, etc.)
- **Distraction Announcements**: Non-exam course announcements
- **Past Exams**: Some exams already occurred (before Jan 15, 2025)
- **No Exam Courses**: Some courses have no final exam

### 3. Data Validation
- Date format: MM/DD/YYYY (e.g., 01/20/2025)
- Time format: HH:MM (e.g., 14:00)
- Normalized string comparison (handles case, whitespace, etc.)
- Numeric comparison for credits (4.0 == 4)

## Implementation Details

### Reset Method
The `reset()` method performs:
1. **Generate Exam Data**: Create courses, announcements, emails
2. **Clear Database**: Initialize fresh Canvas/Email databases
3. **Create Courses**: Set up Canvas courses with announcements
4. **Inject Emails**: Add exam notification emails to inbox
5. **Copy Template**: Place initial Excel template in workspace

### Step Method
The `step()` method:
1. **Load Files**: Read agent's Excel file and groundtruth
2. **Check Order**: Verify chronological sorting
3. **Compare Content**: Match all fields for each course
4. **Return Result**: Provide reward and detailed feedback

## Testing

Run the test suite:
```bash
cd /path/to/canvas-arrange-exam-s2l/
python test_env.py
```

Test output includes:
- Environment initialization
- File generation
- Database statistics
- Method functionality

## Dependencies

- `gem`: Core environment framework
- `pandas`: Excel file processing
- `openpyxl`: Excel file read/write
- `Canvas Database`: Local Canvas LMS database
- `Email Database`: Local email database

## Integration with MCP Servers

The environment works with:
- **canvas-simplified**: Canvas LMS operations
- **emails-simplified**: Email operations
- **memory**: Student profile storage
- **excel**: Excel file manipulation

## Troubleshooting

### Common Issues

**1. Import Errors**
```python
# Ensure gem package is in Python path
import sys
sys.path.insert(0, '/path/to/gem')
```

**2. Missing Dependencies**
```bash
pip install pandas openpyxl
```

**3. Database Issues**
- Check `local_db/canvas/` directory exists
- Verify database files are not corrupted
- Clear and reinitialize with `env.reset()`

**4. Excel Format Issues**
- Use MM/DD/YYYY for dates (not MM/DD)
- Use HH:MM for times (e.g., 09:00, not 9:00)
- Ensure all 11 columns present

## Advanced Usage

### Custom Preprocessing
```python
# Access preprocessing functions directly
from main import run_preprocessing

success = run_preprocessing(
    agent_workspace="/path/to/workspace",
    task_dir="/path/to/task",
    num_courses=20,
    difficulty="expert",
    seed=999
)
```

### Direct Evaluation
```python
from check_local import check_local

success, error = check_local(
    agent_workspace="/path/to/agent/workspace",
    groundtruth_workspace="/path/to/groundtruth"
)
```

## Notes

- **Local Database**: Uses JSON-based local database (no real Canvas API)
- **Email Time**: Exam emails sent on January 1, 2025 at 10:00 AM
- **Reference Date**: Exams scheduled around January 15-30, 2025
- **Student Profile**: Ronald Kelly (rkelly27@mcp.com)
- **Reproducibility**: Use same seed for consistent data generation

## Related Environments

- **canvas-list-test-s2l**: Organize assignments and quizzes into CSV files
- **canvas-arrange-exam-s2l**: This environment (exam schedules)

## License

Part of the GEM (General Environment for Multi-task) benchmark suite.

