# OSWorld Monitor

A web-based monitoring dashboard for OSWorld tasks and executions.

## Overview

This monitor provides a visual interface to track the status, progress, and results of OSWorld tasks. It allows you to:

- View all tasks grouped by type
- Monitor task execution status in real-time
- See detailed execution steps with screenshots and videos
- Check task results

> Important! Make sure you run the monitor after the main runner has started executing tasks. Otherwise, it may cause issues when executing tasks.

## Configuration

The monitor can be configured by editing the `.env` file in the monitor directory. The following variables can be customized:

| Variable | Description | Default Value |
|----------|-------------|---------------|
| TASK_CONFIG_PATH | Path to the task configuration file | ../evaluation_examples/test.json |
| EXAMPLES_BASE_PATH | Base path for example files | ../evaluation_examples/examples |
| RESULTS_BASE_PATH | Base path for storing results | ../results |
| ACTION_SPACE | Action space type (e.g., pyautogui, keyboard) | pyautogui |
| OBSERVATION_TYPE | Type of observation (e.g., screenshot, video) | screenshot |
| MODEL_NAME | Name of the model to use for task execution | computer-use-preview |
| MAX_STEPS | Maximum steps to display for a task | 150 |
| FLASK_PORT | Port for the web server | 80 |
| FLASK_HOST | Host address for the web server | 0.0.0.0 |
| FLASK_DEBUG | Enable debug mode (true/false) | false |

For example:
```bash
# .env
TASK_CONFIG_PATH=../evaluation_examples/test.json
EXAMPLES_BASE_PATH=../evaluation_examples/examples
RESULTS_BASE_PATH=../results
ACTION_SPACE=pyautogui
OBSERVATION_TYPE=screenshot
MODEL_NAME=computer-use-preview
MAX_STEPS=150
FLASK_PORT=80
FLASK_HOST=0.0.0.0
FLASK_DEBUG=true
```

## Running with Docker

The recommended way to run the monitor is using Docker with the provided Docker Compose configuration.

### Prerequisites

- Docker and Docker Compose installed on your system
- OSWorld repository cloned to your local machine
- Environment variables set in the `.env` file

### Starting the Monitor

1. Navigate to the monitor directory:
   ```bash
   cd /path/to/OSWorld/monitor
   ```

2. Edit the `.env` file if you need to customize any settings.

3. Build and start the Docker container:
   ```bash
   docker-compose up -d
   ```

4. Access the monitor in your web browser at:
   ```
   http://{your-ip-address}:{FLASK_PORT}
   ```

### Stopping the Monitor

To stop the monitor:
```bash
docker-compose down
```

### Viewing Logs

To view the monitor logs:
```bash
docker-compose logs -f
```

## Running Without Docker

If you prefer to run the monitor directly, make sure you have created a .env file with the necessary configurations. You will also need to install the required Python packages.

1. Install the required Python packages:
   ```bash
   pip install -r requirements.txt
   ```

2. Start the monitor:
   ```bash
   python main.py
   ```

## Features

- **Task Overview**: View all tasks with their status, progress, and basic information
- **Task Filtering**: Filter tasks by status (all, active, completed)
- **Task Details**: Detailed view of each task showing step-by-step execution
- **Screenshots**: View screenshots captured during task execution

## Troubleshooting

If you encounter issues:

1. Check the logs for errors
2. Verify the paths in `.env` file point to valid directories
3. Ensure the Docker daemon is running (if using Docker)
4. Check that the port is not already in use by another application
5. Make sure you set the security group rules to allow access to the specified port
