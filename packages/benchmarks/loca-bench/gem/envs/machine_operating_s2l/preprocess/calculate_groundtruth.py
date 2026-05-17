#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Script for calculating sensor anomaly data
Function: Filter data from live_sensor_data.csv for August 19, 2025, 11:30-12:30,
          compare against normal parameter ranges in machine_operating_parameters.xlsx,
          identify all anomalous readings and generate a report
"""

import pandas as pd
from datetime import datetime
import os

def load_sensor_data(file_path):
    """
    Load sensor real-time data

    Args:
        file_path: CSV file path

    Returns:
        DataFrame: Sensor data
    """
    df = pd.read_csv(file_path)
    # Convert timestamp column to datetime type
    df['timestamp'] = pd.to_datetime(df['timestamp'])
    return df

def load_operating_parameters(file_path):
    """
    Load machine normal operating parameter ranges

    Args:
        file_path: Excel file path

    Returns:
        DataFrame: Parameter range data
    """
    df = pd.read_excel(file_path)
    return df

def filter_time_range(df, start_time, end_time):
    """
    Filter data within specified time range

    Args:
        df: Sensor data DataFrame
        start_time: Start time string
        end_time: End time string

    Returns:
        DataFrame: Filtered data
    """
    start_dt = pd.to_datetime(start_time)
    end_dt = pd.to_datetime(end_time)

    # Filter data within time range
    mask = (df['timestamp'] >= start_dt) & (df['timestamp'] <= end_dt)
    filtered_df = df[mask].copy()

    print(f"Filter time range: {start_time} to {end_time}")
    print(f"Filtered data count: {len(filtered_df)} records")

    return filtered_df

def identify_anomalies(sensor_data, parameters):
    """
    Identify readings that exceed normal ranges

    Args:
        sensor_data: Sensor data DataFrame
        parameters: Parameter range DataFrame

    Returns:
        DataFrame: Anomaly records
    """
    anomalies = []

    # Iterate through each sensor data record
    for idx, row in sensor_data.iterrows():
        machine_id = row['machine_id']
        sensor_type = row['sensor_type']
        reading = row['reading']
        timestamp = row['timestamp']

        # Find parameter range for corresponding machine and sensor type
        param_mask = (parameters['machine_id'] == machine_id) & \
                     (parameters['sensor_type'] == sensor_type)
        param_row = parameters[param_mask]

        if len(param_row) == 0:
            # If no corresponding parameter range is found, skip
            continue

        # Get minimum and maximum values
        min_value = param_row['min_value'].values[0]
        max_value = param_row['max_value'].values[0]

        # Check if reading exceeds range
        if reading < min_value or reading > max_value:
            anomaly = {
                'timestamp': timestamp.strftime('%Y-%m-%d %H:%M:%S.%f'),  # Preserve milliseconds
                'machine_id': machine_id,
                'sensor_type': sensor_type,
                'reading': reading,
                'normal_range': f'{min_value:.2f} - {max_value:.2f}'
            }
            anomalies.append(anomaly)

    # Preserve column structure even if empty
    if len(anomalies) == 0:
        anomalies_df = pd.DataFrame(columns=['timestamp', 'machine_id', 'sensor_type', 'reading', 'normal_range'])
    else:
        anomalies_df = pd.DataFrame(anomalies)
    print(f"\nFound anomaly data: {len(anomalies)} records")

    return anomalies_df

def save_anomaly_report(anomalies_df, output_path):
    """
    Save anomaly report as CSV file

    Args:
        anomalies_df: Anomaly data DataFrame
        output_path: Output file path
    """
    # Ensure output directory exists
    output_dir = os.path.dirname(output_path)
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    # Save CSV file
    anomalies_df.to_csv(output_path, index=False)
    print(f"\nAnomaly report saved to: {output_path}")
    print(f"Report contains {len(anomalies_df)} anomaly records")

def main():
    """
    Main function: Execute complete anomaly detection workflow
    """
    # Parse command line arguments
    import argparse
    from pathlib import Path
    import glob

    parser = argparse.ArgumentParser(description="Generate anomaly detection groundtruth report")
    parser.add_argument("--sensor-data", type=str, help="Sensor data CSV file path")
    parser.add_argument("--parameters", type=str, help="Machine parameters Excel file path")
    parser.add_argument("--output", type=str, help="Output anomaly report CSV file path")
    parser.add_argument("--task-root", type=str, help="Task root directory")
    args = parser.parse_args()

    script_dir = Path(__file__).parent

    # Determine file paths
    if args.task_root:
        # Use provided task_root
        task_root = Path(args.task_root)
    else:
        # Backward compatible: auto-detect (parent of code directory)
        task_root = script_dir.parent

    # Sensor data path
    if args.sensor_data:
        sensor_data_path = args.sensor_data
    else:
        # Default location: task_root/files/machine_operating/live_sensor.csv
        sensor_data_candidates = [
            task_root / "files" / "machine_operating" / "live_sensor.csv",
            script_dir / "live_sensor_data.csv",  # Backward compatible
            script_dir / "machine_operating" / "live_sensor.csv",  # Backward compatible
        ]

        sensor_data_path = None
        for candidate in sensor_data_candidates:
            if candidate.exists():
                sensor_data_path = str(candidate)
                break

        if not sensor_data_path:
            print("Error: Cannot find sensor data file")
            print(f"   Please ensure file exists at: {task_root / 'files' / 'machine_operating' / 'live_sensor.csv'}")
            return

    # Parameters file path
    if args.parameters:
        parameters_path = args.parameters
    else:
        # Default location: task_root/initial_workspace/machine_operating_parameters.xlsx
        parameters_candidates = [
            task_root / "initial_workspace" / "machine_operating_parameters.xlsx",
            script_dir / "machine_operating_parameters.xlsx",  # Backward compatible
        ]

        parameters_path = None
        for candidate in parameters_candidates:
            if candidate.exists():
                parameters_path = str(candidate)
                break

        if not parameters_path:
            print("Error: Cannot find machine parameters file")
            print(f"   Please ensure file exists at: {task_root / 'initial_workspace' / 'machine_operating_parameters.xlsx'}")
            return

    # Output file path
    if args.output:
        output_path = args.output
    else:
        # Default location: task_root/groundtruth_workspace/anomaly_report.csv
        output_path = str(task_root / "groundtruth_workspace" / "anomaly_report.csv")

    print(f"Using files:")
    print(f"  Sensor data: {sensor_data_path}")
    print(f"  Parameter configuration: {parameters_path}")
    print(f"  Output report: {output_path}")

    # Define time range
    start_time = '2025-08-19 11:30:00'
    end_time = '2025-08-19 12:30:00'

    print("="*60)
    print("Starting sensor anomaly detection task")
    print("="*60)

    # 1. Load sensor data
    print("\n1. Loading sensor data...")
    sensor_data = load_sensor_data(sensor_data_path)
    print(f"   Loaded {len(sensor_data)} sensor records")

    # 2. Load parameter ranges
    print("\n2. Loading machine operating parameter ranges...")
    parameters = load_operating_parameters(parameters_path)
    print(f"   Loaded {len(parameters)} parameter configurations")

    # 3. Filter time range
    print("\n3. Filtering data within time range...")
    filtered_data = filter_time_range(sensor_data, start_time, end_time)

    # 4. Identify anomalies
    print("\n4. Identifying anomalous readings...")
    anomalies = identify_anomalies(filtered_data, parameters)

    # 5. Save report
    print("\n5. Saving anomaly report...")
    save_anomaly_report(anomalies, output_path)

    # Display sample anomaly data
    if len(anomalies) > 0:
        print("\nAnomaly data samples (first 10):")
        print(anomalies.head(10).to_string())

    print("\n="*60)
    print("Task completed!")
    print("="*60)

if __name__ == '__main__':
    main()