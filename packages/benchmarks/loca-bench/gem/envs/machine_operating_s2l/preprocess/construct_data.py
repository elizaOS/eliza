#!/usr/bin/env python3
"""
Factory IoT Sensor Data Generator - Highly Configurable Version

Generates the following files:
1. live_sensor_data.csv - Sensor real-time data
2. machine_operating_parameters.xlsx - Machine operating parameter configuration

Includes multiple sensor types and anomaly patterns for testing anomaly detection systems.
Supports large-scale data generation and complexity adjustment.
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import random
import os
import argparse
from typing import Dict, List, Tuple
import json
from pathlib import Path

class DataGenerationConfig:
    """Data generation configuration class"""
    def __init__(self):
        # Basic configuration
        self.random_seed = 42
        self.time_duration_hours = 2
        self.sampling_interval_minutes = 5
        self.anomaly_probability = 0.15

        # Extended configuration
        self.additional_machines = 0  # Additional machine count (old method)
        self.additional_sensors = []  # Additional sensor types (old method)
        self.total_machines = None  # Total machine count (new method, preferred)
        self.selected_sensors = None  # Selected sensor list (new method, preferred)
        self.complexity_multiplier = 1.0  # Complexity multiplier
        self.output_prefix = ""  # Output file prefix
        self.output_dir = "."  # Output file directory

        # High difficulty mode configuration
        self.enable_multi_anomaly = False  # Multiple anomalies
        self.enable_cascade_failure = False  # Cascade failure
        self.enable_seasonal_patterns = False  # Seasonal patterns
        self.enable_noise_injection = False  # Noise injection

# Set random seed to ensure reproducibility
config = DataGenerationConfig()

class IndustrialSensorDataGenerator:
    def __init__(self, config: DataGenerationConfig):
        self.config = config
        
        # Set random seed
        np.random.seed(config.random_seed)
        random.seed(config.random_seed)

        # Base machine configuration
        self.base_machines = {
            'M001': 'Assembly Line A - Component Insertion',
            'M002': 'Assembly Line B - Circuit Board Assembly', 
            'M003': 'Packaging Unit 1 - Primary Packaging',
            'M004': 'Packaging Unit 2 - Secondary Packaging',
            'M005': 'Quality Control Station - Inspection',
            'M006': 'Welding Robot 1 - Chassis Welding',
            'M007': 'Welding Robot 2 - Frame Welding',
            'M008': 'Paint Booth - Spray Coating',
            'M009': 'Cooling System - Temperature Control',
            'M010': 'Compressor Unit - Air Supply'
        }
        
        # Initialize machine list
        if config.total_machines is not None:
            # Use new method: directly specify total count
            if config.total_machines <= 10:
                # Less than or equal to 10 machines, select directly from base machines
                machine_ids = list(self.base_machines.keys())[:config.total_machines]
                self.machines = {mid: self.base_machines[mid] for mid in machine_ids}
            else:
                # More than 10 machines, first take all base machines, then generate additional ones
                self.machines = self.base_machines.copy()
                # Set number of additional machines needed
                config.additional_machines = config.total_machines - 10
        else:
            # Use old method: base machines + additional machines
            self.machines = self.base_machines.copy()
        
        print(f"Configuration: {len(self.machines)} machines (initial), {config.time_duration_hours} hours of data, {config.sampling_interval_minutes} minute intervals")
        
        # Basic sensor types and normal ranges
        self.base_sensor_types = {
            'temperature': {
                'unit': '°C',
                'normal_ranges': {
                    'M001': (18, 25),    # Precision assembly, strict temperature requirements
                    'M002': (20, 28),    # Circuit board assembly
                    'M003': (15, 30),    # Packaging unit
                    'M004': (15, 30),
                    'M005': (20, 24),    # Quality control station, precision environment
                    'M006': (25, 45),    # Welding robot, higher temperature
                    'M007': (25, 45),
                    'M008': (22, 35),    # Paint booth
                    'M009': (5, 15),     # Cooling system, lower temperature
                    'M010': (20, 35)     # Compressor
                }
            },
            'pressure': {
                'unit': 'bar',
                'normal_ranges': {
                    'M001': (0.8, 1.2),
                    'M002': (0.9, 1.1),
                    'M003': (0.7, 1.3),
                    'M004': (0.7, 1.3),
                    'M005': (0.95, 1.05),
                    'M006': (1.5, 2.5),   # Welding requires higher pressure
                    'M007': (1.5, 2.5),
                    'M008': (2.0, 3.0),   # Spraying requires high pressure
                    'M009': (0.5, 1.0),
                    'M010': (6.0, 8.0)    # Compressor high pressure
                }
            },
            'vibration': {
                'unit': 'mm/s',
                'normal_ranges': {
                    'M001': (0.1, 0.8),
                    'M002': (0.1, 0.6),
                    'M003': (0.2, 1.0),
                    'M004': (0.2, 1.0),
                    'M005': (0.05, 0.3),  # Quality control station requires minimal vibration
                    'M006': (0.5, 2.0),   # Welding robot has significant vibration
                    'M007': (0.5, 2.0),
                    'M008': (0.3, 1.5),
                    'M009': (0.1, 0.5),
                    'M010': (1.0, 3.0)    # Compressor has maximum vibration
                }
            },
            'rpm': {
                'unit': 'rpm',
                'normal_ranges': {
                    'M001': (1200, 1800),
                    'M002': (1000, 1500),
                    'M003': (800, 1200),
                    'M004': (800, 1200),
                    'M005': (500, 800),
                    'M006': (0, 100),     # Welding robot low speed
                    'M007': (0, 100),
                    'M008': (2000, 3000), # High spray speed
                    'M009': (1500, 2500), # Cooling fan
                    'M010': (3000, 4500)  # Compressor high speed
                }
            },
            'current': {
                'unit': 'A',
                'normal_ranges': {
                    'M001': (2.0, 5.0),
                    'M002': (1.5, 4.0),
                    'M003': (3.0, 6.0),
                    'M004': (3.0, 6.0),
                    'M005': (1.0, 2.5),
                    'M006': (15, 25),     # Welding high current
                    'M007': (15, 25),
                    'M008': (8.0, 12.0),
                    'M009': (5.0, 10.0),
                    'M010': (20, 30)      # Compressor high current
                }
            },
            'flow_rate': {
                'unit': 'L/min',
                'normal_ranges': {
                    'M001': (10, 20),
                    'M002': (8, 15),
                    'M003': (5, 12),
                    'M004': (5, 12),
                    'M005': (2, 8),
                    'M006': (25, 40),     # Welding coolant flow rate
                    'M007': (25, 40),
                    'M008': (50, 80),     # Large paint spray flow rate
                    'M009': (100, 150),   # Maximum cooling system flow rate
                    'M010': (15, 30)
                }
            }
        }

        # Initialize sensor types
        if config.selected_sensors is not None:
            # Use new method: directly specify sensor list
            self.sensor_types = {}
            for sensor_name in config.selected_sensors:
                if sensor_name in self.base_sensor_types:
                    self.sensor_types[sensor_name] = self.base_sensor_types[sensor_name]
        else:
            # Use old method: base sensors + additional sensors
            self.sensor_types = self.base_sensor_types.copy()
            self._generate_additional_sensors()

        # Generate additional machines
        # When additional machines are needed (either old method or when total_machines > 10 in new method)
        if config.additional_machines > 0:
            self._generate_additional_machines()
            print(f"Added {config.additional_machines} additional machines, current total: {len(self.machines)} machines")

        # Generate selected additional sensors for new method (if selected_sensors contains non-basic sensors)
        if config.selected_sensors is not None:
            self._generate_selected_additional_sensors()

        # Extended anomaly pattern definitions (based on complexity multiplier)
        self.anomaly_patterns = {
            'sudden_spike': {
                'description': 'Sudden spike anomaly',
                'duration': (1, 3),  # 1-3 time points
                'severity': (1.5, 3.0)  # Multiples beyond normal range
            },
            'gradual_drift': {
                'description': 'Gradual drift anomaly',
                'duration': (10, 30),  # 10-30 time points
                'severity': (1.2, 2.0)
            },
            'oscillation': {
                'description': 'Oscillation anomaly',
                'duration': (5, 15),
                'severity': (1.3, 2.5)
            },
            'sensor_failure': {
                'description': 'Sensor failure',
                'duration': (3, 8),
                'severity': (0.1, 0.3)  # Abnormally low readings or zero
            }
        }

        # If complex mode is enabled, add more complex anomaly patterns
        if config.enable_multi_anomaly:
            self._add_complex_anomaly_patterns()

    def _generate_additional_machines(self):
        """Generate additional machines"""
        machine_types = [
            'Conveyor Belt', 'Sorting Unit', 'Cutting Machine', 'Drilling Unit',
            'Polishing Station', 'Heating Furnace', 'Cooling Tower', 'Pump Station',
            'Generator Unit', 'Motor Drive', 'Hydraulic System', 'Pneumatic System',
            'Laser Cutter', 'CNC Machine', 'Testing Equipment', 'Packaging Robot'
        ]
        
        for i in range(self.config.additional_machines):
            machine_id = f"M{len(self.machines) + 1:03d}"
            machine_type = random.choice(machine_types)
            section = chr(65 + (i // 5))  # A, B, C, ...
            
            self.machines[machine_id] = f"{machine_type} {section} - Extended Unit {i+1}"

            # Generate sensor ranges for new machine
            self._generate_sensor_ranges_for_machine(machine_id)

    def _generate_sensor_ranges_for_machine(self, machine_id: str):
        """Generate sensor ranges for new machine"""
        for sensor_type, config in self.sensor_types.items():
            if machine_id not in config['normal_ranges']:
                # Generate reasonable ranges based on machine type and random variation
                base_ranges = list(config['normal_ranges'].values())
                if base_ranges:
                    # Randomly select a similar base range as template
                    template_range = random.choice(base_ranges)
                    min_val, max_val = template_range

                    # Add variation (±20%)
                    variation = 0.2 * random.uniform(-1, 1)
                    new_min = min_val * (1 + variation)
                    new_max = max_val * (1 + variation)
                    
                    # Ensure min < max
                    if new_min > new_max:
                        new_min, new_max = new_max, new_min
                    
                    config['normal_ranges'][machine_id] = (
                        round(new_min, 2), round(new_max, 2)
                    )

    def _generate_additional_sensors(self):
        """Generate additional sensor types"""
        additional_sensor_configs = {
            'humidity': {
                'unit': '%RH',
                'base_range': (30, 70)
            },
            'power': {
                'unit': 'kW',
                'base_range': (1, 50)
            },
            'efficiency': {
                'unit': '%',
                'base_range': (75, 95)
            },
            'noise_level': {
                'unit': 'dB',
                'base_range': (40, 80)
            },
            'oil_pressure': {
                'unit': 'psi',
                'base_range': (20, 60)
            },
            'speed': {
                'unit': 'm/s',
                'base_range': (0.5, 5.0)
            }
        }
        
        for sensor_name in self.config.additional_sensors:
            if sensor_name in additional_sensor_configs and sensor_name not in self.sensor_types:
                sensor_config = additional_sensor_configs[sensor_name]
                base_min, base_max = sensor_config['base_range']

                # Generate ranges for this sensor on each machine
                normal_ranges = {}
                for machine_id in self.machines.keys():
                    # Adjust range based on machine type
                    machine_multiplier = self._get_machine_type_multiplier(machine_id, sensor_name)

                    min_val = base_min * machine_multiplier * random.uniform(0.8, 1.2)
                    max_val = base_max * machine_multiplier * random.uniform(0.8, 1.2)

                    if min_val > max_val:
                        min_val, max_val = max_val, min_val

                    normal_ranges[machine_id] = (round(min_val, 2), round(max_val, 2))
                
                self.sensor_types[sensor_name] = {
                    'unit': sensor_config['unit'],
                    'normal_ranges': normal_ranges
                }

    def _generate_selected_additional_sensors(self):
        """Generate selected additional sensors for new method (non-basic sensors)"""
        additional_sensor_configs = {
            'humidity': {
                'unit': '%RH',
                'base_range': (30, 70)
            },
            'power': {
                'unit': 'kW',
                'base_range': (1, 50)
            },
            'efficiency': {
                'unit': '%',
                'base_range': (75, 95)
            },
            'noise_level': {
                'unit': 'dB',
                'base_range': (40, 80)
            },
            'oil_pressure': {
                'unit': 'psi',
                'base_range': (20, 60)
            },
            'speed': {
                'unit': 'm/s',
                'base_range': (0.5, 5.0)
            }
        }
        
        # Check if selected sensors include additional sensors
        for sensor_name in self.config.selected_sensors:
            if sensor_name in additional_sensor_configs and sensor_name not in self.sensor_types:
                sensor_config = additional_sensor_configs[sensor_name]
                base_min, base_max = sensor_config['base_range']
                
                # Generate ranges for this sensor on each machine
                normal_ranges = {}
                for machine_id in self.machines.keys():
# Adjust range based on machine type
                    machine_multiplier = self._get_machine_type_multiplier(machine_id, sensor_name)
                    
                    min_val = base_min * machine_multiplier * random.uniform(0.8, 1.2)
                    max_val = base_max * machine_multiplier * random.uniform(0.8, 1.2)
                    
                    if min_val > max_val:
                        min_val, max_val = max_val, min_val
                    
                    normal_ranges[machine_id] = (round(min_val, 2), round(max_val, 2))
                
                self.sensor_types[sensor_name] = {
                    'unit': sensor_config['unit'],
                    'normal_ranges': normal_ranges
                }

    def _get_machine_type_multiplier(self, machine_id: str, sensor_type: str) -> float:
        """Get sensor multiplier based on machine type"""
        machine_desc = self.machines[machine_id].lower()
        
        multipliers = {
            'humidity': {
                'cooling': 1.5, 'paint': 0.7, 'welding': 0.5, 'quality': 1.2
            },
            'power': {
                'welding': 3.0, 'compressor': 2.5, 'assembly': 0.5, 'quality': 0.3
            },
            'efficiency': {
                'quality': 1.1, 'assembly': 1.0, 'welding': 0.8, 'paint': 0.9
            },
            'noise_level': {
                'compressor': 1.8, 'welding': 1.5, 'quality': 0.6, 'assembly': 1.0
            },
            'oil_pressure': {
                'welding': 1.5, 'compressor': 2.0, 'assembly': 0.8, 'paint': 1.2
            },
            'speed': {
                'assembly': 1.5, 'packaging': 2.0, 'quality': 0.5, 'cooling': 1.0
            }
        }
        
        if sensor_type in multipliers:
            for keyword, multiplier in multipliers[sensor_type].items():
                if keyword in machine_desc:
                    return multiplier
        
        return 1.0  # Default multiplier

    def _add_complex_anomaly_patterns(self):
        """Add complex anomaly patterns"""
        complex_patterns = {
            'intermittent_failure': {
                'description': 'Intermittent failure',
                'duration': (2, 8),
                'severity': (0.1, 0.5),
                'gap_duration': (3, 10)  # Failure interval
            },
            'thermal_runaway': {
                'description': 'Thermal runaway',
                'duration': (15, 50),
                'severity': (2.0, 4.0)
            },
            'harmonic_resonance': {
                'description': 'Harmonic resonance',
                'duration': (8, 20),
                'severity': (1.8, 3.5)
            },
            'cascade_failure': {
                'description': 'Cascade failure',
                'duration': (20, 60),
                'severity': (1.5, 2.5),
                'spread_probability': 0.3
            }
        }
        
        self.anomaly_patterns.update(complex_patterns)

    def generate_normal_reading(self, machine_id: str, sensor_type: str) -> float:
        """Generate sensor readings within normal range"""
        min_val, max_val = self.sensor_types[sensor_type]['normal_ranges'][machine_id]
        
        # Use normal distribution, keeping most readings in the center of normal range
        center = (min_val + max_val) / 2
        std = (max_val - min_val) / 6  # 3-sigma rule
        
        reading = np.random.normal(center, std)

        reading = np.clip(reading, min_val, max_val)
        
        return round(reading, 2)

    def generate_anomaly_reading(self, machine_id: str, sensor_type: str,
                               pattern: str, intensity: float) -> float:
        """Generate anomaly readings

        Ensure the generated readings are outside the normal range so they can be identified by anomaly detection algorithms.
        """
        min_val, max_val = self.sensor_types[sensor_type]['normal_ranges'][machine_id]

        # Minimum anomaly offset to ensure readings exceed normal range
        MIN_OFFSET_RATIO = 0.05  # At least 5% beyond range
        range_size = max_val - min_val
        min_offset = range_size * MIN_OFFSET_RATIO

        if pattern == 'sensor_failure':
            # Sensor failure: abnormally low or near zero
            # Ensure reading is below min_val
            upper_bound = min(min_val * intensity, min_val - min_offset)
            upper_bound = max(0, upper_bound)  # Ensure non-negative
            return round(random.uniform(0, upper_bound), 2)
        else:
            # Other anomalies: exceed normal range
            # Ensure intensity makes readings exceed range
            effective_intensity = max(intensity, 1.0 + MIN_OFFSET_RATIO)

            if random.choice([True, False]):
                # Exceed upper limit - ensure reading > max_val
                reading = max_val * effective_intensity
                # Additional guarantee to exceed range
                if reading <= max_val:
                    reading = max_val + min_offset
                return round(reading, 2)
            else:
                # Below lower limit - ensure reading < min_val
                reading = min_val / effective_intensity
                # Additional guarantee to exceed range
                if reading >= min_val:
                    reading = min_val - min_offset
                return round(reading, 2)

    def inject_anomalies(self, data: List[Dict]):
        """Inject anomalies into data

        Use a pre-planned approach to ensure anomalies are evenly distributed throughout the time range:
        1. First build time index to determine when each (machine_id, sensor_type) appears
        2. For each combination, randomly select anomaly session start points on its time series
        3. Ensure anomaly sessions are distributed throughout the time range
        """
        anomaly_probability = self.config.anomaly_probability * self.config.complexity_multiplier

        # Step 1: Organize data index by (machine_id, sensor_type)
        sensor_indices = {}  # {(machine_id, sensor_type): [index1, index2, ...]}
        for i, record in enumerate(data):
            key = (record['machine_id'], record['sensor_type'])
            if key not in sensor_indices:
                sensor_indices[key] = []
            sensor_indices[key].append(i)

        # Step 2: Plan anomaly sessions in advance for each machine/sensor combination
        total_anomaly_records = 0

        for (machine_id, sensor_type), indices in sensor_indices.items():
            num_time_points = len(indices)
            if num_time_points == 0:
                continue

            # Calculate expected anomaly count for this combination (based on probability)
            expected_anomalies = int(num_time_points * anomaly_probability)
            if expected_anomalies == 0:
                continue

            # Generate anomaly sessions to distribute across time range
            # Divide time series into segments, each may contain one anomaly session
            avg_session_duration = 10  # Average session duration (estimated)
            num_segments = max(1, expected_anomalies // avg_session_duration)
            segment_size = num_time_points // num_segments

            current_pos = 0
            while current_pos < num_time_points:
                # Randomly decide whether to start anomaly in current segment
                segment_end = min(current_pos + segment_size, num_time_points)

                # Use probability to decide whether to have anomaly in this segment
                if random.random() < anomaly_probability * 3:  # Increase probability to compensate for segment division
                    # Select anomaly pattern
                    pattern = random.choice(list(self.anomaly_patterns.keys()))
                    pattern_config = self.anomaly_patterns[pattern]

                    duration = random.randint(*pattern_config['duration'])
                    intensity = random.uniform(*pattern_config['severity'])

                    # Randomly select start position within segment
                    max_start = max(current_pos, segment_end - duration)
                    if max_start > current_pos:
                        start_pos = random.randint(current_pos, max_start)
                    else:
                        start_pos = current_pos

                    # Randomly select start position within segment
                    BASE_INTENSITY = 1.1

                    # Generate anomaly readings for each time point in the session
                    for j in range(duration):
                        pos = start_pos + j
                        if pos >= num_time_points:
                            break
                        idx = indices[pos]
                        record = data[idx]

                        # Calculate progress and intensity
                        progress = j / max(duration - 1, 1)

                        if pattern == 'gradual_drift':
                            effective_intensity = BASE_INTENSITY + (intensity - BASE_INTENSITY) * progress
                        elif pattern == 'oscillation':
                            oscillation_factor = abs(np.sin(2 * np.pi * progress * 3))
                            effective_intensity = BASE_INTENSITY + (intensity - BASE_INTENSITY) * oscillation_factor
                        else:
                            effective_intensity = intensity

                        record['reading'] = self.generate_anomaly_reading(
                            machine_id, sensor_type, pattern, effective_intensity
                        )
                        record['is_anomaly'] = True
                        total_anomaly_records += 1

                    # Skip the session length just injected
                    current_pos = start_pos + duration
                else:
                    current_pos = segment_end

    def generate_sensor_data(self) -> pd.DataFrame:
        """Generate sensor data"""
        hours = self.config.time_duration_hours
        interval_minutes = self.config.sampling_interval_minutes
        
        print(f"Generating {hours} hours of sensor data, sampling interval {interval_minutes} minutes...")
        
        # Use fixed time range to ensure it includes the time period required for groundtruth evaluation
        # We generate a larger range to provide sufficient context data
        target_middle_time = datetime(2025, 8, 19, 12, 0, 0)  # Midpoint of target time period
        
# Calculate start and end times to ensure target time period is centered
        half_duration = timedelta(hours=hours / 2)
        start_time = target_middle_time - half_duration
        end_time = target_middle_time + half_duration
        
        print(f"Time range: {start_time.strftime('%Y-%m-%d %H:%M:%S')} to {end_time.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"(Includes groundtruth evaluation time period: 2025-08-19 11:30:00 to 12:30:00)")
        
        # Generate data points at configured intervals
        time_points = []
        current_time = start_time
        while current_time <= end_time:
            time_points.append(current_time)
            current_time += timedelta(minutes=interval_minutes)
        
        data = []

        # Generate data for each timestamp, each machine, and each sensor
        for timestamp in time_points:
            for machine_id in self.machines.keys():
                for sensor_type in self.sensor_types.keys():
                    reading = self.generate_normal_reading(machine_id, sensor_type)
                    
                    data.append({
                        'timestamp': timestamp,
                        'machine_id': machine_id,
                        'sensor_type': sensor_type,
                        'reading': reading,
                        'is_anomaly': False
                    })
        
        # Inject anomalies
        print("Injecting anomaly data...")
        self.inject_anomalies(data)
        
        # Convert to DataFrame
        df = pd.DataFrame(data)

        # If noise injection is enabled, add random noise
        if self.config.enable_noise_injection:
            # Inject random noise
            print("Injecting random noise...")
            self._inject_noise(df)
        
        df = df.sort_values(['timestamp', 'machine_id', 'sensor_type'])

        # Remove is_anomaly column (internal flag)
        final_df = df[['timestamp', 'machine_id', 'sensor_type', 'reading']].copy()

        print(f"Generated {len(final_df)} sensor records")
        print(f"Contains {df['is_anomaly'].sum()} anomaly records ({df['is_anomaly'].mean()*100:.1f}%)")

        # Debug: output anomaly time distribution
        anomaly_df = df[df['is_anomaly'] == True]
        if len(anomaly_df) > 0:
            print(f"Anomaly time range: {anomaly_df['timestamp'].min()} to {anomaly_df['timestamp'].max()}")
            # Check anomalies in evaluation time window
            eval_start = datetime(2025, 8, 19, 11, 30, 0)
            eval_end = datetime(2025, 8, 19, 12, 30, 0)
            eval_anomalies = anomaly_df[(anomaly_df['timestamp'] >= eval_start) & (anomaly_df['timestamp'] <= eval_end)]
            print(f"Anomalies in evaluation time window (11:30-12:30): {len(eval_anomalies)}")
        
        return final_df

    def _inject_noise(self, df: pd.DataFrame):
        """Inject random noise"""
        for idx, row in df.iterrows():
            if not row.get('is_anomaly', False):  # Only add noise to normal data
                machine_id = row['machine_id']
                sensor_type = row['sensor_type']
                
                # Get normal range
                min_val, max_val = self.sensor_types[sensor_type]['normal_ranges'][machine_id]
                range_size = max_val - min_val
                
                # Generate random noise
                noise = np.random.normal(0, range_size * 0.01)
                df.at[idx, 'reading'] = round(row['reading'] + noise, 2)

    def generate_parameters_config(self) -> pd.DataFrame:
        """Generate machine operating parameter configuration"""
        print("Generating machine operating parameter configuration...")
        
        config_data = []
        
        for machine_id, description in self.machines.items():
            for sensor_type, config in self.sensor_types.items():
                min_val, max_val = config['normal_ranges'][machine_id]
                unit = config['unit']
                
                config_data.append({
                    'machine_id': machine_id,
                    'machine_description': description,
                    'sensor_type': sensor_type,
                    'unit': unit,
                    'min_value': min_val,
                    'max_value': max_val,
                    'calibration_date': '2024-01-15',
                    'next_maintenance': '2024-07-15'
                })
        
        df = pd.DataFrame(config_data)
        print(f"Generated {len(df)} parameter configuration items")
        
        return df

    def save_data(self, sensor_data: pd.DataFrame, config_data: pd.DataFrame):
        """Save data to files"""
        print("Saving data files...")
        
       # Ensure output directory exists
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        prefix = self.config.output_prefix
        if prefix and not prefix.endswith('_'):
            prefix += '_'
        
        # Save sensor data to CSV file
        sensor_file = output_dir / f'{prefix}live_sensor_data.csv'
        sensor_data.to_csv(sensor_file, index=False)
        print(f"Sensor data saved to: {sensor_file}")
        
        # Save machine operating parameters to Excel file
        config_file = output_dir / f'{prefix}machine_operating_parameters.xlsx'
        with pd.ExcelWriter(config_file, engine='openpyxl') as writer:
            config_data.to_excel(writer, sheet_name='Operating Parameters', index=False)
            
            # Save machine summary to Excel file
            summary_data = []
            for machine_id, description in self.machines.items():
                sensor_count = len(self.sensor_types)
                summary_data.append({
                    'machine_id': machine_id,
                    'description': description,
                    'sensor_count': sensor_count,
                    'status': 'Active'
                })
            
            summary_df = pd.DataFrame(summary_data)
            summary_df.to_excel(writer, sheet_name='Machine Summary', index=False)
        
        print(f"Parameters configuration saved to: {config_file}")

    def generate_data_stats(self, sensor_data: pd.DataFrame) -> Dict:
        """Generate data statistics"""
        stats = {
            'total_records': len(sensor_data),
            'time_range': {
                'start': sensor_data['timestamp'].min().isoformat(),
                'end': sensor_data['timestamp'].max().isoformat()
            },
            'machines': list(sensor_data['machine_id'].unique()),
            'sensor_types': list(sensor_data['sensor_type'].unique()),
            'records_per_machine': sensor_data['machine_id'].value_counts().to_dict(),
            'records_per_sensor': sensor_data['sensor_type'].value_counts().to_dict()
        }
        
       # Ensure output directory exists
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # Save statistics
        stats_file = output_dir / (f'{self.config.output_prefix}_data_generation_stats.json' if self.config.output_prefix else 'data_generation_stats.json')
        with open(stats_file, 'w', encoding='utf-8') as f:
            json.dump(stats, f, indent=2, ensure_ascii=False)
        
        return stats

def parse_arguments():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description='Factory IoT Sensor Data Generator - Highly Configurable Version',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Usage examples:
  # Basic usage
  python main.py
  
  # Generate large dataset
  python main.py --hours 24 --interval 1 --machines 50 --complexity 2.0
  
  # High difficulty mode
  python main.py --hours 12 --machines 20 --sensors humidity,power,efficiency \\
                 --multi-anomaly --cascade-failure --noise
  
  # Custom output
  python main.py --hours 6 --prefix "large_dataset" --anomaly-rate 0.25
        """
    )
    
    # Basic configuration
    parser.add_argument('--hours', type=float, default=2,
                        help='Data time span (hours), default: 2')
    parser.add_argument('--interval', type=float, default=5,
                        help='Sampling interval (minutes), default: 5')
    parser.add_argument('--anomaly-rate', type=float, default=0.15,
                        help='Anomaly probability, default: 0.15')
    parser.add_argument('--seed', type=int, default=42,
                        help='Random seed, default: 42')
    
    # Extended configuration
    parser.add_argument('--machines', type=int, default=0,
                        help='Additional machines to add, default: 0 (deprecated, use --total-machines)')
    parser.add_argument('--total-machines', type=int, default=None,
                        help='Total machines to generate, default: None')
    parser.add_argument('--sensors', type=str, default='',
                        help='Additional sensor types, comma-separated (deprecated, use --total-sensors)')
    parser.add_argument('--total-sensors', type=str, default=None,
                        help='Sensor configuration: can be a number (e.g., "3" for first 3 base sensors) or comma-separated sensor name list. Base sensors: temperature,pressure,vibration,rpm,current,flow_rate. Optional additional sensors: humidity,power,efficiency,noise_level,oil_pressure,speed')
    parser.add_argument('--complexity', type=float, default=1.0,
                        help='Complexity multiplier, default: 1.0')
    parser.add_argument('--prefix', type=str, default='',
                        help='Output file prefix, default: none')
    parser.add_argument('--output-dir', type=str, default='.',
                        help='Output file directory, default: current directory')
    
    # High difficulty mode
    parser.add_argument('--multi-anomaly', action='store_true',
                        help='Enable multi-anomaly mode')
    parser.add_argument('--cascade-failure', action='store_true',
                        help='Enable cascade failure mode')
    parser.add_argument('--seasonal-patterns', action='store_true',
                        help='Enable seasonal patterns')
    parser.add_argument('--noise', action='store_true',
                        help='Enable noise injection')
    
    # Preset mode
    parser.add_argument('--preset', choices=['small', 'medium', 'large', 'extreme'],
                        help='Preset configuration mode')
    
    return parser.parse_args()

def apply_preset_config(config: DataGenerationConfig, preset: str):
    """Apply preset configuration"""
    presets = {
        'small': {
            'time_duration_hours': 1,
            'sampling_interval_minutes': 10,
            'additional_machines': 0,
            'additional_sensors': [],
            'complexity_multiplier': 0.8
        },
        'medium': {
            'time_duration_hours': 6,
            'sampling_interval_minutes': 5,
            'additional_machines': 10,
            'additional_sensors': ['humidity', 'power'],
            'complexity_multiplier': 1.5
        },
        'large': {
            'time_duration_hours': 24,
            'sampling_interval_minutes': 2,
            'additional_machines': 25,
            'additional_sensors': ['humidity', 'power', 'efficiency', 'noise_level'],
            'complexity_multiplier': 2.0,
            'enable_multi_anomaly': True,
            'enable_noise_injection': True
        },
        'extreme': {
            'time_duration_hours': 72,
            'sampling_interval_minutes': 1,
            'additional_machines': 50,
            'additional_sensors': ['humidity', 'power', 'efficiency', 'noise_level', 'oil_pressure', 'speed'],
            'complexity_multiplier': 3.0,
            'enable_multi_anomaly': True,
            'enable_cascade_failure': True,
            'enable_seasonal_patterns': True,
            'enable_noise_injection': True,
            'anomaly_probability': 0.25
        }
    }
    
    if preset in presets:
        preset_config = presets[preset]
        for key, value in preset_config.items():
            setattr(config, key, value)
        print(f"Applied preset configuration: {preset}")

def main():
    """Main function"""
    args = parse_arguments()
    
    # Create configuration
    config = DataGenerationConfig()
    
    if args.preset:
        apply_preset_config(config, args.preset)
    
    config.random_seed = args.seed
    config.time_duration_hours = args.hours
    config.sampling_interval_minutes = args.interval
    config.anomaly_probability = args.anomaly_rate
    config.complexity_multiplier = args.complexity
    config.output_prefix = args.prefix
    config.output_dir = args.output_dir
    
    # Handle machine count parameters (prioritize total-machines)
    if args.total_machines is not None:
        # Directly specify total machine count (new method)
        config.total_machines = args.total_machines
    else:
        # Use old machines parameter (backward compatible)
        config.additional_machines = args.machines

    # Handle sensor parameters (prioritize total-sensors)
    if args.total_sensors is not None:
        # Directly specify sensor list (new method)
        # Support comma-separated strings or numbers (if number, take first N base sensors)
        if isinstance(args.total_sensors, str) and ',' in args.total_sensors:
            # String list format
            config.selected_sensors = [s.strip() for s in args.total_sensors.split(',') if s.strip()]
        else:
            # Try to parse as number
            try:
                # Take first N base sensors
                num_sensors = int(args.total_sensors)
                base_sensor_list = ['temperature', 'pressure', 'vibration', 'rpm', 'current', 'flow_rate']
                # Take first N base sensors
                config.selected_sensors = base_sensor_list[:num_sensors]
            except ValueError:
                # Single sensor name format
                config.selected_sensors = [args.total_sensors.strip()]
    else:
        # Use old sensors parameter (backward compatible)
        # Use old sensors parameter (backward compatible)
        if args.sensors:
            config.additional_sensors = [s.strip() for s in args.sensors.split(',')]
    
    # High difficulty mode configuration
    config.enable_multi_anomaly = args.multi_anomaly
    config.enable_cascade_failure = args.cascade_failure
    config.enable_seasonal_patterns = args.seasonal_patterns
    config.enable_noise_injection = args.noise
    
    # Display configuration information
    print("=" * 80)
    print("=" * 80)
    
    # Calculate machine and sensor quantities
    if config.total_machines is not None:
        total_machines = config.total_machines
    else:
        total_machines = 10 + config.additional_machines
    
    if config.selected_sensors is not None:
        total_sensors = len(config.selected_sensors)
    else:
        total_sensors = 6 + len(config.additional_sensors)
    
    estimated_records = int((config.time_duration_hours * 60 / config.sampling_interval_minutes) * total_machines * total_sensors)
    
    print(f"Configuration Summary:")
    print(f"  Time span: {config.time_duration_hours} hours")
    print(f"  Sampling interval: {config.sampling_interval_minutes} minutes")

    # Display machine quantity information
    if config.total_machines is not None:
        print(f"  Machine count: {total_machines}")
    else:
        print(f"  Machine count: {total_machines} ({10} base + {config.additional_machines} extended)")

    # Display sensor information
    if config.selected_sensors is not None:
        print(f"  Sensor types: {total_sensors}")
        print(f"  Selected sensors: {', '.join(config.selected_sensors)}")
    else:
        print(f"  Sensor types: {total_sensors} ({6} base + {len(config.additional_sensors)} extended)")
        if config.additional_sensors:
            # Display additional sensors
            print(f"  Additional sensors: {', '.join(config.additional_sensors)}")

    print(f"  Estimated records: {estimated_records:,}")
    print(f"  Anomaly probability: {config.anomaly_probability:.1%}")
    print(f"  Complexity multiplier: {config.complexity_multiplier}")

    advanced_features = []
    if config.enable_multi_anomaly:
        advanced_features.append("Multi-anomaly")
    if config.enable_cascade_failure:
        advanced_features.append("Cascade failure")
    if config.enable_seasonal_patterns:
        advanced_features.append("Seasonal patterns")
    if config.enable_noise_injection:
        advanced_features.append("Noise injection")

    if advanced_features:
        print(f"  Advanced features: {', '.join(advanced_features)}")

    print("\nStarting data generation...")
    
    # Create generator
    generator = IndustrialSensorDataGenerator(config)
    
    # Generate data
    sensor_data = generator.generate_sensor_data()
    config_data = generator.generate_parameters_config()
    
    # Save data
    generator.save_data(sensor_data, config_data)
    
    # Generate statistics
    stats = generator.generate_data_stats(sensor_data)
    
    print("\n" + "=" * 80)
    print("Data generation completed!")
    print("=" * 80)
    print(f"Total sensor records: {stats['total_records']:,}")
    print(f"Time range: {stats['time_range']['start']} to {stats['time_range']['end']}")
    print(f"Machine count: {len(stats['machines'])}")
    print(f"Sensor types: {len(stats['sensor_types'])}")

    # Estimate data size
    estimated_size_mb = stats['total_records'] * 0.1 / 1000  # Rough estimation
    print(f"Estimated data size: ~{estimated_size_mb:.1f} MB")

    prefix = config.output_prefix + '_' if config.output_prefix else ''
    print(f"\nGenerated files:")
    print(f"1. {prefix}live_sensor_data.csv - Sensor real-time data")
    print(f"2. {prefix}machine_operating_parameters.xlsx - Machine operating parameters configuration")
    print(f"3. {prefix}data_generation_stats.json - Data generation statistics")

    if estimated_records > 100000:
        print(f"\n💡 Large-scale dataset generation completed!")
        print(f"   It is recommended to specify a time range when using anomaly detection scripts to improve performance")

if __name__ == "__main__":
    main() 