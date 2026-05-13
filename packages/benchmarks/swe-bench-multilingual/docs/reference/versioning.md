# Versioning System

!!! note "Create Training Data"

    If you interested in creating tasks for training models to solve software engineering tasks,
    check out [SWE-smith](https://swesmith.com/) ([Code](https://github.com/SWE-bench/SWE-smith), [Paper](https://swesmith.com/assets/paper.pdf)).

    SWE-smith is a toolkit for creating execution environments and SWE-bench style task instances at scale.
    
    It is designed to be highly compatible with [SWE-agent](https://github.com/SWE-agent/SWE-agent),
    to generate training data, and SWE-bench for evaluation.

## Overview

SWE-bench assigns each task instance a specific `version` with respect to its repository. This version information is crucial for ensuring reproducible execution-based evaluation, as it determines the exact installation instructions needed for that repository.

## How Versioning Works

When task instances are created, they are assigned a version based on the repository's state at the time of issue creation. This version information enables the evaluation harness to set up the correct environment for testing the proposed patch.

## Tools for Version Management

### General Purpose Tool: `get_versions.py`

The `get_versions.py` script is a general-purpose tool for retrieving version information. It can obtain versions through two methods:

1. Reading directly from the GitHub repository
2. Building the repository locally and locating appropriate version files

The script assigns each task instance a new `version: <value>` key/value pair in its metadata.

### Usage

The script can be invoked via the `run_get_version.sh` wrapper script:

```bash
python get_versions.py \
    --instances_path   [Required] [folder] Path to candidate task instances \
    --retrieval_method [Required] [choice] Method to retrieve versions ("build", "mix", or "github") \
    --cleanup          [Required] [bool]   Remove testbed and conda environments upon task completion \
    --conda_env        [Required] [str]    Name of conda environment to run task installation within \
    --num_workers      [Required] [int]    Number of processes to parallelize on \
    --path_conda       [Required] [folder] Path to miniconda or anaconda installation \
    --output_dir       [Required] [folder] Path to directory to write versioned task instances to \
    --testbed          [Required] [folder] Path to testbed directory, for cloning GitHub repos to
```

### Repository-Specific Version Extraction

For certain repositories, SWE-bench provides specialized scripts in the `extract_web/` directory that crawl the package's website to find versions and their cutoff dates.

These scripts (like `get_versions_*.py`) can be adapted to other repositories to check task instances' `creation_date` against the version dates.

## Integration with Evaluation

The version information is used by the evaluation harness to:

1. Set up the correct Docker environment for each task
2. Install the proper dependencies based on the version
3. Ensure consistent evaluation conditions across runs

This versioning system is a key component in making SWE-bench evaluations reproducible and reliable. 