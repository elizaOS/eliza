# Apply PhD Email S2L Environment

## Overview

This environment implements a PhD application material organization task where an AI agent must:
1. Read an email from a professor with submission instructions
2. Organize application materials according to a specific folder structure
3. Process files (rename, merge PDFs, extract information from PDFs)
4. Retrieve personal information from memory
5. Create and send a ZIP file via email

## Task Description

The agent receives an email from "kaiming" containing detailed instructions for organizing and submitting PhD application materials. The materials are initially in a flat directory structure (`Application_Materials_flat/`) and need to be reorganized into a hierarchical structure with specific naming conventions.

### Key Requirements

1. **Folder Structure**: Create a structured directory hierarchy
2. **File Processing**:
   - Rename `CV.pdf` to `Resume.pdf`
   - Read recommendation letter PDFs to extract professor names
   - Merge all award certificates chronologically into one PDF
3. **Memory Integration**: Retrieve personal name and student ID from memory
4. **Email Submission**: Send organized materials as ZIP to specified recipient

## Environment Structure

```
apply_phd_email_s2l/
├── apply_phd_email_s2l.py    # Main environment class
├── __init__.py                # Module initialization
├── README.md                  # This file
├── preprocess/                # Preprocessing scripts
│   └── main.py               # Setup email database and materials
├── evaluation/                # Evaluation scripts
│   ├── main.py               # Main evaluation logic
│   └── check_local_email.py  # Email and attachment validation
├── initial_workspace/         # Initial files for agent
│   └── files.tar.gz          # Compressed application materials
├── groundtruth_workspace/     # Reference for validation
│   ├── files.tar.gz          # Expected organized materials
│   └── today.txt             # Date reference
├── generate_task_config.py    # Configuration generator
└── email_config.json         # Email account configuration
```

## Reset Process

During `reset()`, the environment:

1. **Generates Task Configuration**:
   - Creates professor list with different response types
   - Generates email content with specific instructions
   - Configures file structure requirements
   
2. **Initializes Email Database**:
   - Sets up local email database
   - Creates user accounts (sender and receiver)
   - Imports generated emails

3. **Prepares Initial Workspace**:
   - Copies compressed application materials to agent workspace
   - Files remain compressed until agent extracts them

4. **Generates Groundtruth**:
   - Creates reference folder structure
   - Prepares expected file organization

## Step Process

During `step()`, the environment validates:

1. **Email Sent**: Agent sent email to correct recipient
2. **Subject Correct**: Email subject contains "submit_material"
3. **Attachment Present**: ZIP file attached to email
4. **Folder Structure**: Files organized according to requirements
5. **File Processing**:
   - CV.pdf renamed to Resume.pdf
   - Recommendation letters renamed with actual professor names
   - Award certificates merged chronologically
6. **Content Validation**: PDF content matches expected format

## Configuration Parameters

- `num_professors`: Number of professors to generate (default: 10)
- `structure`: File structure variant (default: "standard")
- `receiver_idx`: Receiver index for selection (default: 0)
- `seed`: Random seed for reproducibility
- `num_positive`: Number of positive professor responses (default: 1)
- `assign_different_structures`: Whether different professors require different structures
- Various weights for different response types

## Parallel Execution Safety

The environment is designed to support parallel execution:

- Uses unique module names based on `id(self)` to avoid conflicts
- All generated files are stored in instance-specific task directories
- No shared state between environment instances
- Subprocess-based preprocessing and evaluation for isolation

## Success Criteria

The task is considered successful when:

1. Email is sent to the correct recipient with correct subject
2. ZIP attachment contains properly organized folder structure
3. All required files are present and correctly named
4. Award certificates are merged in chronological order
5. Recommendation letters are renamed with extracted professor names
6. Personal information is correctly used in folder naming

## Example Usage

```python
from gem.envs.apply_phd_email_s2l import ApplyPhDEmailS2LEnv

# Create environment instance
env = ApplyPhDEmailS2LEnv(
    task_dir="/path/to/task_dir",
    num_professors=10,
    num_positive=1,
    seed=42,
    verbose=True
)

# Reset environment
instruction, info = env.reset()

# Agent performs task...
# ...

# Evaluate results
observation, reward, terminated, truncated, info = env.step(action="done")

print(f"Success: {info['success']}")
print(f"Reward: {reward}")
```

## Notes

- The environment requires `EmailDatabase` from mcp_convert
- PDF processing requires PyPDF2 library
- File extraction uses Python's tarfile module
- All intermediate files are stored in task-specific directories
- Logging is configured per-instance to avoid conflicts



