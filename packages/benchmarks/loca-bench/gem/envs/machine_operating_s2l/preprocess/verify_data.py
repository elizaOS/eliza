#!/usr/bin/env python3
"""
Data Verification Script - Check the quality of generated sensor data
"""

import pandas as pd
import numpy as np

def verify_sensor_data():
    """Verify sensor data"""
    print("Verifying sensor data...")
    
    # Load data
    sensor_data = pd.read_csv('live_sensor_data.csv')
    params_data = pd.read_excel('machine_operating_parameters.xlsx', sheet_name='Operating Parameters')

    print(f"Sensor data record count: {len(sensor_data)}")
    print(f"Parameter configuration record count: {len(params_data)}")

    # Check data structure
    print("\nSensor data columns:", sensor_data.columns.tolist())
    print("Parameter configuration columns:", params_data.columns.tolist())

    # Check machines and sensor types
    machines = sensor_data['machine_id'].unique()
    sensor_types = sensor_data['sensor_type'].unique()

    print(f"\nNumber of machines: {len(machines)}")
    print(f"Number of sensor types: {len(sensor_types)}")
    print(f"Machine IDs: {sorted(machines)}")
    print(f"Sensor types: {sorted(sensor_types)}")

    # Check anomaly data
    print("\nChecking anomaly data...")
    
    # Merge data for comparison
    merged = sensor_data.merge(
        params_data[['machine_id', 'sensor_type', 'min_value', 'max_value']],
        on=['machine_id', 'sensor_type']
    )

    # Identify anomalies
    merged['is_below_min'] = merged['reading'] < merged['min_value']
    merged['is_above_max'] = merged['reading'] > merged['max_value']
    merged['is_anomaly'] = merged['is_below_min'] | merged['is_above_max']

    anomaly_count = merged['is_anomaly'].sum()
    anomaly_rate = merged['is_anomaly'].mean() * 100

    print(f"Number of anomaly data points: {anomaly_count}")
    print(f"Anomaly data ratio: {anomaly_rate:.1f}%")

    # Analyze anomalies by machine
    print("\nAnomaly statistics by machine:")
    anomaly_by_machine = merged.groupby('machine_id')['is_anomaly'].agg(['sum', 'count', 'mean'])
    anomaly_by_machine['anomaly_rate'] = anomaly_by_machine['mean'] * 100
    print(anomaly_by_machine[['sum', 'anomaly_rate']].round(1))

    # Analyze anomalies by sensor type
    print("\nAnomaly statistics by sensor type:")
    anomaly_by_sensor = merged.groupby('sensor_type')['is_anomaly'].agg(['sum', 'count', 'mean'])
    anomaly_by_sensor['anomaly_rate'] = anomaly_by_sensor['mean'] * 100
    print(anomaly_by_sensor[['sum', 'anomaly_rate']].round(1))

    # Display some anomaly samples
    print("\nAnomaly data samples:")
    anomalies = merged[merged['is_anomaly']].copy()
    anomalies['normal_range'] = anomalies['min_value'].astype(str) + ' - ' + anomalies['max_value'].astype(str)
    sample_anomalies = anomalies[['timestamp', 'machine_id', 'sensor_type', 'reading', 'normal_range']].head(10)
    print(sample_anomalies.to_string(index=False))

    # Check time range
    print(f"\nTime range:")
    print(f"Start time: {sensor_data['timestamp'].min()}")
    print(f"End time: {sensor_data['timestamp'].max()}")

    # Check data distribution
    print(f"\nData distribution check:")
    for sensor_type in sensor_types:
        type_data = sensor_data[sensor_data['sensor_type'] == sensor_type]['reading']
        print(f"{sensor_type}: min={type_data.min():.2f}, max={type_data.max():.2f}, mean={type_data.mean():.2f}")

def verify_parameters_config():
    """Verify parameter configuration"""
    print("\n" + "="*50)
    print("Verifying parameter configuration file...")

    params_data = pd.read_excel('machine_operating_parameters.xlsx', sheet_name='Operating Parameters')

    # Check if each machine has configuration for all sensor types
    machines = params_data['machine_id'].unique()
    sensor_types = params_data['sensor_type'].unique()

    print(f"Number of machines in configuration: {len(machines)}")
    print(f"Number of sensor types in configuration: {len(sensor_types)}")

    # Check completeness
    expected_configs = len(machines) * len(sensor_types)
    actual_configs = len(params_data)

    print(f"Expected configuration count: {expected_configs}")
    print(f"Actual configuration count: {actual_configs}")

    if expected_configs == actual_configs:
        print("Configuration completeness check passed")
    else:
        print("Configuration incomplete")

    # Display parameter configuration samples
    print("\nParameter configuration samples:")
    sample_params = params_data[['machine_id', 'sensor_type', 'min_value', 'max_value', 'unit']].head(10)
    print(sample_params.to_string(index=False))

if __name__ == "__main__":
    verify_sensor_data()
    verify_parameters_config()
    print("\n" + "="*50)
    print("Data verification completed!") 