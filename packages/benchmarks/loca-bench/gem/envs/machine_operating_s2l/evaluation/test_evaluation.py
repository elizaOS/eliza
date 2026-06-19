#!/usr/bin/env python3
"""
Test evaluation script functionality
"""

import os
import tempfile
import pandas as pd
import subprocess
import json

def create_test_agent_data():
    """Create test agent anomaly report data"""
    agent_data = [
        ["timestamp", "machine_id", "sensor_type", "reading", "normal_range"],
        ["2025-08-19 11:52:08", "M001", "temperature", "25.07", "18.0 - 25.0"],
        ["2025-08-19 12:17:08", "M005", "speed", "0.23", "0.25 - 2.95"],
        ["2025-08-19 12:27:08", "M004", "pressure", "0.69", "0.7 - 1.3"]
    ]
    
    return agent_data

def create_test_groundtruth_data():
    """Create test groundtruth anomaly report data"""
    groundtruth_data = [
        ["timestamp", "machine_id", "sensor_type", "reading", "normal_range", "anomaly_type", "unit", "severity"],
        ["2025-08-19 11:52:08.269059", "M001", "temperature", "25.07", "18.0 - 25.0 °C", "above_maximum", "°C", "Low"],
        ["2025-08-19 12:17:08.269059", "M005", "speed", "0.23", "0.25 - 2.95 m/s", "below_minimum", "m/s", "Low"],
        ["2025-08-19 12:27:08.269059", "M004", "pressure", "0.69", "0.7 - 1.3 bar", "below_minimum", "bar", "Low"],
        ["2025-08-19 12:32:08.269059", "M006", "vibration", "2.5", "0.5 - 2.0 mm/s", "above_maximum", "mm/s", "Medium"]
    ]
    
    return groundtruth_data

def create_test_log_file():
    """Create test log file"""
    log_data = {
        "config": {
            "launch_time": "2025-08-19 11:00:00"
        },
        "messages": [
            {"role": "user", "content": "Test message"},
            {"role": "assistant", "content": "Test response"}
        ]
    }
    return log_data

def write_csv_file(file_path: str, data: list):
    """Write CSV file"""
    with open(file_path, 'w', encoding='utf-8') as f:
        for row in data:
            f.write(','.join(str(item) for item in row) + '\n')

def test_evaluation():
    """Test evaluation script"""
    print("Testing Machine Operating Anomaly Detection Evaluation")

    # Create temporary directory
    with tempfile.TemporaryDirectory() as temp_dir:
        print(f"Using temporary directory: {temp_dir}")

        # Create agent workspace
        agent_workspace = os.path.join(temp_dir, "agent_workspace")
        os.makedirs(agent_workspace)

        # Create groundtruth workspace
        groundtruth_workspace = os.path.join(temp_dir, "groundtruth_workspace")
        os.makedirs(groundtruth_workspace)

        # Create test files
        agent_file = os.path.join(agent_workspace, "anomaly_report.csv")
        groundtruth_file = os.path.join(groundtruth_workspace, "training_set_anomaly_report.csv")
        log_file = os.path.join(temp_dir, "test_log.json")

        # Write test data
        write_csv_file(agent_file, create_test_agent_data())
        write_csv_file(groundtruth_file, create_test_groundtruth_data())

        with open(log_file, 'w', encoding='utf-8') as f:
            json.dump(create_test_log_file(), f)

        print(f"Test files created:")
        print(f"   Agent file: {agent_file}")
        print(f"   Groundtruth file: {groundtruth_file}")
        print(f"   Log file: {log_file}")

        # Run evaluation script
        eval_script = os.path.join(os.path.dirname(__file__), "main.py")
        
        cmd = [
            "python", eval_script,
            "--agent_workspace", agent_workspace,
            "--groundtruth_workspace", groundtruth_workspace,
            "--res_log_file", log_file,
            "--time_tolerance", "120",  # 2 minute tolerance
            "--reading_tolerance", "0.01",
            "--test_mode"  # Enable test mode, use local files instead of GCS
        ]

        print(f"\nRunning evaluation command:")
        print(f"   {' '.join(cmd)}")
        
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

            print(f"\nEvaluation Result:")
            print(f"   Return code: {result.returncode}")

            if result.stdout:
                print(f"\nSTDOUT:")
                print(result.stdout)

            if result.stderr:
                print(f"\nSTDERR:")
                print(result.stderr)

            if result.returncode == 0:
                print(f"\nEvaluation test PASSED!")
                return True
            else:
                print(f"\nEvaluation test FAILED!")
                return False

        except subprocess.TimeoutExpired:
            print(f"\nEvaluation test TIMEOUT!")
            return False
        except Exception as e:
            print(f"\nEvaluation test ERROR: {e}")
            return False

if __name__ == "__main__":
    success = test_evaluation()
    exit(0 if success else 1) 