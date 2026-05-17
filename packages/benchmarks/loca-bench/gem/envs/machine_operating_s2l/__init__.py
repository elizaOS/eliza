"""
Machine Operating S2L Environment

This environment simulates a factory IoT scenario where an AI agent needs to:
1. Query sensor data from BigQuery (machine_operating.live_sensor)
2. Compare readings against normal operating parameter ranges
3. Identify anomalies (readings outside normal ranges)
4. Generate anomaly report with required fields
5. Upload the report to Cloud Storage bucket

The task tests the agent's ability to:
- Query and filter data from BigQuery with time constraints
- Read and process Excel configuration files
- Perform data comparison and anomaly detection
- Generate structured CSV reports
- Interact with Google Cloud Storage

Author: Adapted from machine-operating-s2l task
Version: 1.0
"""

from .machine_operating_s2l import MachineOperatingS2LEnv

__all__ = ["MachineOperatingS2LEnv"]



