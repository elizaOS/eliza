# Nl2RepoBench

## Project Overview

NL2Repo is a benchmark designed to evaluate the performance of Large Language Models (LLMs) and coding agents on **long-horizon tasks** that require generating a **complete, runnable code repository from scratch (0-to-1)**. The benchmark consists of **104 distinct tasks**, each paired with its own testing environment.

## Running the Code

The current setup runs OpenHands in **headless batch mode**. Model behavior is controlled via the `config.toml` file. If you need to change the model configuration, please modify `config.toml` **before** starting the run.

The system currently uses a **file-to-file** execution workflow and manages Docker containers via **python-on-whales**. At the moment, **only local execution is supported**.

> **Note:** When running in headless mode across multiple machines, you must set up shared file management (e.g., NFS) or manually transfer files to the target machines in advance.

### Prerequisites

Before starting, ensure that Docker is installed locally and that the following images are available:

- `docker.all-hands.dev/all-hands-ai/openhands:0.56`
- `docker.all-hands.dev/all-hands-ai/runtime:0.56-nikolaik`

The runtime image can be customized. The default image is sufficient for running Python-based tasks and comes with **Python 3.12** preinstalled. If you need to support other languages, you can build your own runtime image and update the corresponding configuration in `openhands/openhands_app.py` (line 176).

## Data Layout

1. The `test_files` directory contains all repository-related task data, including:
   - A `.txt` file specifying the number of test cases
   - The repository documentation in `.md` format
   - Two `.json` files used for testing

2. All Docker volume mounts used for headless execution are stored in the `workspaces` directory. Each task is assigned a **unique UUID directory**. The task-specific configuration file is copied from a template and modified accordingly (mainly to mount the workspace directory into the runtime container).

3. Final results are saved in the `result` directory. Each task produces a single aggregated `.json` file, named using the task’s randomly generated UUID.

4. The project is launched using a `config.json` file. A sample configuration is shown below:

```json
{
  "startPro": [
    {
      "moduleName": "",
      "baseUrl": "",
      "sk": "",
      "proNameList": [
        "math-verify"
      ]
    }
  ],
  "max_pool_size": 20
}
```

### Configuration Fields

- **startPro**: A list of task nodes.
  - Each node corresponds to a single model configuration.
  - **proNameList**: A list of task names, which must match the subdirectory names under `test_files`.

- **max_pool_size**: The maximum number of concurrent threads. Once this limit is reached, additional tasks will be queued until resources become available.

