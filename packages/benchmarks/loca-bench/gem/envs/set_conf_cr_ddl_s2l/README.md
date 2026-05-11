# Set Conference Camera-Ready Deadline S2L Environment

## Overview

The **SetConfCrDdlS2LEnv** environment simulates a conference reminder management scenario where an AI agent needs to process email notifications about camera-ready deadlines and create calendar reminders.

## Task Description

The agent is given a task to:

1. Check the inbox for camera-ready deadline notifications from conferences
2. Review the conference information file in the workspace to identify target conferences
3. For each conference with a camera-ready deadline, set a calendar reminder 3 hours before the deadline
4. Ensure the event summaries include relevant keywords (conference name, "camera", "ready")
5. Handle reminder emails and deadline extensions correctly (always use the latest deadline)

## Environment Setup

### Databases

This environment uses two local databases:

- **Email Database** (`local_db/emails`): Stores conference notification emails
- **Calendar Database** (`local_db/calendar`): Stores calendar events and reminders

### Directory Structure

```
task_dir/
├── agent_workspace/           # Agent's working directory
│   └── conference_info.txt    # List of conferences the user submitted to
├── local_db/                  # Local database directory
│   ├── emails/                # Email database
│   └── calendar/              # Calendar database
├── files/                     # Generated email backup
│   └── emails_backup.json     # All generated emails
├── groundtruth_workspace/     # Evaluation reference
│   ├── conference_metadata.json  # Target conferences and deadlines
│   └── today.txt              # Base date
└── logs/                      # Environment logs
    └── env.log                # Detailed execution log
```

## Configuration Parameters

### Basic Parameters

- `task_dir`: Directory for task-related files
- `num_target`: Number of target conferences with camera-ready deadlines (default: 1)
- `num_noise`: Number of noise conferences without target information (default: 2)
- `noise_emails`: Number of emails per noise conference (default: 2)
- `max_conferences`: Maximum conference pool size (default: 200)
- `seed`: Random seed for reproducibility (default: 42)
- `verbose`: Enable console logging (default: False)

### Difficulty Control Parameters

- `enable_reminders`: Enable reminder emails (default: True)
- `enable_extensions`: Enable deadline extensions (default: True)
- `base_date`: Base date (today) in YYYY-MM-DD format (default: "2025-09-15")
- `deadline_offset`: Days from base_date to deadline (default: 15)
- `difficulty`: Difficulty preset (easy/medium/hard/expert)

### Difficulty Presets

#### Easy
- 1 target conference
- 1 noise conference
- 1 email per noise conference
- No reminder emails
- No deadline extensions
- Total: ~2-3 emails

#### Medium (Default)
- 1 target conference
- 2 noise conferences
- 2 emails per noise conference
- Reminder emails enabled
- No deadline extensions
- Total: ~6-7 emails

#### Hard
- 1 target conference
- 3 noise conferences
- 3 emails per noise conference
- Reminder emails enabled
- Deadline extensions enabled
- Total: ~12-15 emails

#### Expert
- 2-3 target conferences
- 4 noise conferences
- 4 emails per noise conference
- Reminder emails enabled
- Deadline extensions enabled
- Total: ~20-25 emails

## Usage Example

```python
from gem.envs.set_conf_cr_ddl_s2l import SetConfCrDdlS2LEnv

# Create environment with medium difficulty
env = SetConfCrDdlS2LEnv(
    task_dir="/path/to/task",
    difficulty="medium",
    seed=42,
    verbose=True
)

# Reset environment (generates data and initializes databases)
instruction, _ = env.reset()

# Agent performs actions...
# When agent claims done:
observation, reward, terminated, truncated, info = env.step("done")

# Check results
if info["success"]:
    print("Task completed successfully!")
else:
    print(f"Task failed: {info['error']}")
```

## Email Types

### Target Conference Emails

1. **Camera-Ready Notification**: Initial deadline announcement
2. **Reminder Email**: Reminder about approaching deadline (if `enable_reminders=True`)
3. **Extension Notice**: Deadline extension notification (if `enable_extensions=True`)

### Noise Conference Emails

1. **General Update**: Generic conference updates
2. **Workshop CFP**: Workshop call for participation
3. **Registration Reminder**: Registration deadline reminders

## Evaluation Criteria

The agent's solution is evaluated based on:

1. **Correct Conference Identification**: All target conferences identified from emails
2. **Calendar Events Created**: All camera-ready deadlines have corresponding calendar events
3. **Correct Reminder Time**: Each reminder is set exactly 3 hours before the deadline (5-minute tolerance)
4. **Proper Keywords**: Event summaries include conference name, "camera", and "ready"
5. **Extension Handling**: If a deadline is extended, the latest deadline is used

### Success Conditions

- All target conferences have calendar reminders
- All reminders are set 3 hours before the correct deadline
- Event summaries contain appropriate keywords
- Precision and recall both = 100%

## Task Instruction

```
Please check my inbox for camera-ready deadline notifications from conferences I submitted papers to. 
The conference information is in the workspace. For each conference with a camera-ready deadline, 
set a calendar reminder 3 hours before the deadline. Make sure to include relevant keywords 
(conference name, "camera", "ready") in the event summary.
```

## Logging

The environment maintains detailed logs in `task_dir/logs/env.log`:

- Preprocessing steps (email generation, database initialization)
- Evaluation steps (calendar validation, error checking)
- Success/failure details

Console logging is only enabled when `verbose=True`.

## Implementation Details

### Reset Flow

1. Clean and recreate task directory
2. Run email generation script (preprocess/main.py)
3. Initialize Email and Calendar databases
4. Import emails into Email database
5. Copy initial workspace files to agent workspace
6. Generate groundtruth metadata

### Step Flow (Evaluation)

1. Load Calendar database
2. Run evaluation script (evaluation/main.py)
3. Query calendar events in the relevant time range
4. Match events against groundtruth deadlines
5. Verify reminder times (deadline - 3 hours)
6. Check keywords in event summaries
7. Calculate precision and recall
8. Return observation, reward, and info

## Notes

- Each environment instance uses unique module names to avoid conflicts when running in parallel
- All intermediate files (emails, groundtruth, database) are stored in task_dir, not the code directory
- The environment is designed to support parallel execution with different configurations
- Email and Calendar database paths are set via environment variables during preprocessing and evaluation



