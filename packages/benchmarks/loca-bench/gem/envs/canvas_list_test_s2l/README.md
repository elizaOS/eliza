# Canvas List Test S2L Environment

Canvas course testing environment that supports dynamic task configuration generation and complete environment preprocessing.

## Features

- Dynamic course configuration generation
- Support for Quizzes and Assignments
- Course exemption mechanism simulation
- Student submission status management
- Automatic groundtruth data generation
- Memory.json integration
- Complete environment preprocessing workflow (integrated in `reset()` method)
- Local JSON database (no Canvas API required)

## Usage

### 1. Standard Usage (Recommended) - Using reset() Method

```python
from gem.envs.canvas_list_test_s2l import CanvasListTestS2LEnv

# Create environment and specify parameters
env = CanvasListTestS2LEnv(
    task_dir="/path/to/task",
    num_courses=10,          # Number of courses
    num_students=3,          # Number of students
    quiz_prob=0.8,           # Quiz probability
    assignment_prob=0.7,     # Assignment probability
    submission_prob=0.3,     # Submitted probability
    exemption_prob=0.1,      # Exemption probability
    exemption_meet_prob=0.6, # Probability of meeting exemption requirement
    no_exam_prob=0.15,       # No exam probability
    quiz_difficulty="medium", # Quiz difficulty
    assignment_difficulty="medium", # Assignment difficulty
    seed=42                  # Random seed
)

# Call reset() - automatically executes complete preprocessing workflow
# Including: generate config, clear database, create courses, submit assignments
instructions, info = env.reset()

# Get task instructions
print("Task Instructions:")
print(instructions)

# info is empty dictionary {}
print(f"Info: {info}")  # Output: Info: {}
```

### 2. Step-by-Step Execution (Advanced Usage)

For more fine-grained control, you can execute step by step:

```python
from gem.envs.canvas_list_test_s2l import CanvasListTestS2LEnv

# Create environment
env = CanvasListTestS2LEnv(task_dir="/path/to/task", num_courses=5)

# Only generate config (without preprocessing)
stats = env.generate_config()

# Then you can manually operate on database or config files
# ...

# Or execute complete preprocessing workflow via reset()
instructions, info = env.reset()
```

## Parameter Description

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_dir` | str | None | Task directory path |
| `num_courses` | int | 10 | Number of courses |
| `num_students` | int | 3 | Number of students |
| `quiz_prob` | float | 0.8 | Probability each course has a quiz (0-1) |
| `assignment_prob` | float | 0.7 | Probability each course has an assignment (0-1) |
| `submission_prob` | float | 0.3 | Probability assignment is already submitted (0-1) |
| `exemption_prob` | float | 0.1 | Probability course can be exempted (0-1) |
| `exemption_meet_prob` | float | 0.6 | Probability Ryan meets exemption requirement (0-1) |
| `no_exam_prob` | float | 0.15 | Probability course has no exam (0-1) |
| `quiz_difficulty` | str | "medium" | Quiz difficulty (easy/medium/hard) |
| `assignment_difficulty` | str | "medium" | Assignment difficulty (easy/medium/hard) |
| `seed` | int | 42 | Random seed |

## Generated Files

After calling `generate_config()`, the following files will be generated under `task_dir`:

```
task_dir/
├── files/
│   ├── course_config.json         # Course configuration
│   ├── canvas_users.json          # User information
│   └── submission_config.json     # Submission status
├── initial_workspace/
│   └── memory/
│       └── memory.json            # Ryan Brown's memory
└── groundtruth_workspace/
    ├── quiz_info.csv              # Quiz groundtruth
    └── assignment_info.csv        # Assignment groundtruth
```

## Return Values

`generate_config()` returns a dictionary containing statistics:

```python
{
    'courses': 10,                  # Total courses
    'total_exemption_courses': 1,   # Courses with exemption mechanism
    'qualified_exemptions': 1,      # Courses Ryan meets exemption requirement for
    'unqualified_exemptions': 0,    # Courses Ryan does not meet exemption requirement for
    'quizzes': 8,                   # Total quizzes
    'assignments': 7,               # Total assignments
    'total_tasks': 15,              # Total tasks
    'submitted': 2,                 # Submitted count
    'remaining': 13,                # Remaining to complete
    'groundtruth_quizzes': 7,       # Quizzes in groundtruth
    'groundtruth_assignments': 5,   # Assignments in groundtruth
    'groundtruth_total': 12         # Total tasks in groundtruth
}
```

## Examples

See `example_usage.py` for complete examples.

## Notes

1. **Directory Structure**: Ensure `generate_task_config.py` is in the same directory as `canvas_list_test_s2l.py`
2. **Exemption Mechanism**: Courses meeting exemption requirements will not appear in groundtruth
3. **Submitted Assignments**: Already submitted assignments will not appear in groundtruth
4. **Groundtruth**: Groundtruth CSV files are sorted by deadline and course code

## Dependencies

- `gem.core.Env`
- `gem.tools.mcp_server.canvas.database.CanvasDatabase`
- `generate_task_config.TaskConfigGenerator`

## reset() Method Details

The `reset()` method automatically executes the following preprocessing steps:

1. **Generate Task Configuration** (`generate_config()`)
   - Generate course configuration file (`course_config.json`)
   - Generate user configuration file (`canvas_users.json`)
   - Generate submission configuration file (`submission_config.json`)
   - Generate Ryan Brown's memory file (`memory.json`)
   - Generate groundtruth CSV files

2. **Clear Local Database**
   - Delete all existing courses, users, enrollments, etc.
   - Keep default account

3. **Create Courses**
   - Update course due dates to future times
   - Update CSV files (apply exemption and submission filtering)
   - Create all courses and teacher accounts
   - Create Quizzes and Assignments
   - Create exemption policy announcements (if applicable)
   - Enroll all students

4. **Submit Student Assignments**
   - Submit assignments for Ryan Brown based on `submission_config.json`
   - Generate random submission times

5. **Copy Initial CSV Templates**
   - Copy `quiz_info.csv` template to agent_workspace
   - Copy `assignment_info.csv` template to agent_workspace
   - These files contain example format for Agent reference

### Return Values

`reset()` returns `(instructions, info)` tuple:
- `instructions`: Task instruction string (obtained via `_get_instructions()`)
- `info`: Empty dictionary `{}`

Task instruction content:
```
My personal information is all stored in memory. Based on the course
information on Canvas, as well as my assignment and quiz submission status.
Find all my unfinished course assignments and quizzes that have to be
completed (find all assignments and quizzes that I must submit, as according
to information released by the teachers in announcements, some content may
not need to be submitted), organize the information according to the required
fields in the workspace's CSV header, keeping the format consistent with
these examples, and complete these CSV files. In filling the files, please
fill the quizzes/assignments in chronological order by their deadlines (DDL),
and for quizzes/assignmen with the same DDL, sort them in the dictionary
order of the class code. You should directly edit in the given 2 CSV files
without changing their file names.
```

## Version History

- **v1.2.3** (2025-10-06): Fixed event loop closed error (using persistent event loop)
- **v1.2.2** (2025-10-06): Added CSV template file copying step in `reset()`
- **v1.2.1** (2025-10-06): Modified `reset()` return value format, added `_get_instructions()` method
- **v1.2.0** (2025-10-06): Integrated preprocessing workflow into `reset()` method
- **v1.1.0** (2025-10-06): Moved configuration parameters to `__init__` method
- **v1.0.0** (2025-10-05): Initial version

## Technical Details

### Event Loop Management (v1.2.3+)

The environment uses a persistent asyncio event loop to avoid "Event loop is closed" errors:

- Creates event loop in `__init__`, consistent with environment instance lifecycle
- Uses `loop.run_until_complete()` in `reset()` to execute async operations
- Properly cleans up all pending tasks and closes event loop in `__del__`

This ensures all subprocesses (like Canvas MCP stdio server) can be properly cleaned up before the event loop closes.
