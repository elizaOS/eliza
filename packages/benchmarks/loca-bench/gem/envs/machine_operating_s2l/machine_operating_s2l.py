# Standard library imports
import logging
import shutil
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

# Local imports
from gem.core import Env
from gem.utils.constants import TERMINAL_STATE
from gem.utils.filesystem import nfs_safe_rmtree

# Constants
TASK_INSTRUCTION = '''A production line in the factory streams real-time data through IoT sensors into the live_sensor table of the machine_operating dataset in BigQuery. The normal operating parameter ranges (minimum/maximum values) for each machine’s sensors are defined in a configuration file named machine_operating_parameters.xlsx. Please query the live_sensor table in the machine_operating dataset in BigQuery for sensor data between 11:30 and 12:30 on August 19, 2025, and, using the parameter ranges from the Excel file, identify all readings that fall outside their normal ranges (you may choose any efficient method for comparison). Compile the final anomaly report with the fields `timestamp`, `machine_id`, `sensor_type`, `reading`, (the format of these data should be exactly the same as in the BigQuery table) and `normal_range` (min - max)  into a file named "anomaly_report.csv", save it to the workspace, and upload it to the cloud storage bucket named "iot_anomaly_reports" (create it if not exists).'''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'


class MachineOperatingS2LEnv(Env):
    """Machine Operating S2L Environment for anomaly detection from IoT sensor data.
    
    This environment simulates a factory IoT scenario where the agent needs to
    query sensor data from BigQuery, identify anomalies based on parameter ranges,
    and upload the anomaly report to Cloud Storage.
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        hours: float = 72,
        interval_minutes: float = 5,
        anomaly_rate: float = 0.15,
        difficulty: str = "medium",
        total_machines: int = 25,
        total_sensors: str = "6",
        seed: int = 42,
        verbose: bool = False,
        **_,
    ):
        """Initialize the Machine Operating S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            hours: Time duration in hours for data generation
            interval_minutes: Sampling interval in minutes
            anomaly_rate: Anomaly probability
            difficulty: Difficulty level (easy/medium/hard)
            total_machines: Total number of machines to generate (default: 25)
            total_sensors: Total sensor types - either a number or comma-separated names (default: "6")
            seed: Random seed for reproducibility
            verbose: Whether to output to console
        """
        super().__init__()
        self.task_dir = task_dir
        self.verbose = verbose

        # Setup directory paths
        self.agent_workspace = Path(self.task_dir) / "agent_workspace"
        self.data_dir = Path(self.task_dir) / "local_db"
        self.gcloud_data_dir = self.data_dir / "google_cloud"

        # Clear task directory if it exists, then create it
        if Path(self.task_dir).exists():
            nfs_safe_rmtree(self.task_dir)
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        
        # Setup logging system
        self._setup_logging()

        # Configuration generation parameters
        self.hours = hours
        self.interval_minutes = interval_minutes
        self.anomaly_rate = anomaly_rate
        self.difficulty = difficulty
        self.total_machines = total_machines
        self.total_sensors = total_sensors
        self.seed = seed

        self.reset()
    
    def _setup_logging(self) -> None:
        """Setup logging system with separate file and console handlers.
        
        Creates an independent log file for each environment instance.
        Console output is only enabled when verbose mode is active.
        """
        # Create log directory
        log_dir = Path(self.task_dir) / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        
        # Create logger for current instance
        self.logger = logging.getLogger(f"MachineOperatingS2L_{id(self)}")
        self.logger.setLevel(logging.DEBUG)
        
        # Clear existing handlers to avoid duplication
        self.logger.handlers.clear()
        
        # File handler - records detailed logs
        log_file = log_dir / "env.log"
        file_handler = logging.FileHandler(log_file, mode='a', encoding='utf-8')
        file_handler.setLevel(logging.DEBUG)
        file_formatter = logging.Formatter(LOG_FORMAT, datefmt=LOG_DATE_FORMAT)
        file_handler.setFormatter(file_formatter)
        self.logger.addHandler(file_handler)
        
        # Console handler - only outputs key information in verbose mode
        if self.verbose:
            console_handler = logging.StreamHandler()
            console_handler.setLevel(logging.INFO)
            console_formatter = logging.Formatter(CONSOLE_LOG_FORMAT)
            console_handler.setFormatter(console_formatter)
            self.logger.addHandler(console_handler)
        
        # Prevent log propagation
        self.logger.propagate = False
        
        self.logger.info(f"Logging system initialized, log file: {log_file}")
    
    def _get_instructions(self) -> str:
        """Get task instructions for the agent.
        
        Returns:
            str: Task instruction text
        """
        return TASK_INSTRUCTION

    def reset(self, seed: Optional[int] = None) -> Tuple[str, Dict[str, Any]]:
        """Reset environment and execute Machine Operating preprocessing.
        
        Steps include:
        1. Generate machine operating sensor data (CSV files)
        2. Generate machine operating parameters (Excel file)
        3. Calculate groundtruth anomaly report
        4. Clean and initialize BigQuery dataset (machine_operating)
        5. Clean and initialize Cloud Storage bucket (iot_anomaly_reports)
        6. Upload sensor data to BigQuery
        7. Copy initial workspace (parameters Excel) to agent workspace
        
        Args:
            seed: Random seed (optional)
        
        Returns:
            Tuple[str, Dict[str, Any]]: Task instruction and empty dictionary
        """
        super().reset(seed)
        
        try:
            # Clean and recreate task directory
            if Path(self.task_dir).exists():
                nfs_safe_rmtree(self.task_dir)
            Path(self.data_dir).mkdir(parents=True, exist_ok=True)

            # Reinitialize logging system (task_dir was deleted)
            self._setup_logging()

            self.logger.info("Starting Machine Operating preprocessing...")
            self.logger.info("=" * 60)
            
            # Import preprocessing module using importlib to avoid conflicts
            try:
                import importlib.util
                env_dir = Path(__file__).parent
                preprocess_main_path = env_dir / "preprocess" / "main.py"
                
                # Load module with a unique name to avoid conflicts with other environments
                spec = importlib.util.spec_from_file_location(
                    f"machine_operating_s2l_{id(self)}.preprocess_main",
                    preprocess_main_path
                )
                preprocess_main_module = importlib.util.module_from_spec(spec)
                
                # Set up sys.path before loading
                sys.path.insert(0, str(env_dir / "preprocess"))
                try:
                    spec.loader.exec_module(preprocess_main_module)
                finally:
                    # Remove from sys.path after loading
                    if str(env_dir / "preprocess") in sys.path:
                        sys.path.remove(str(env_dir / "preprocess"))
                
            except ImportError as e:
                self.logger.warning(f"Could not import preprocessing module: {e}")
                self.logger.warning(f"Looked in: {env_dir}")
                return self._get_instructions(), {}
            
            # Run preprocessing
            self.logger.info("\nRunning preprocessing pipeline...")
            self.logger.info("=" * 60)
            
            # Call the preprocessing as a subprocess
            try:
                import subprocess
                
                cmd = [
                    sys.executable,
                    str(preprocess_main_path),
                    "--agent_workspace", str(self.agent_workspace),
                    "--hours", str(self.hours),
                    "--interval", str(self.interval_minutes),
                    "--anomaly-rate", str(self.anomaly_rate),
                    "--difficulty", self.difficulty,
                    "--total-machines", str(self.total_machines),
                    "--total-sensors", str(self.total_sensors),
                    "--seed", str(self.seed)
                ]
                
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd=str(env_dir)
                )
                
                if result.stdout:
                    self.logger.info(result.stdout)
                
                if result.returncode != 0:
                    self.logger.error("Preprocessing failed")
                    if result.stderr:
                        self.logger.error(result.stderr)
                    return self._get_instructions(), {}
                
            except Exception as e:
                self.logger.error(f"Error running preprocessing: {e}")
                self.logger.error(traceback.format_exc())
                return self._get_instructions(), {}
            
            # Copy initial workspace to agent workspace
            self._copy_initial_workspace()
            
            self.logger.info("\nMachine Operating preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("Sensor data generated and uploaded to BigQuery")
            self.logger.info("Machine parameters file prepared")
            self.logger.info("BigQuery dataset initialized and populated")
            self.logger.info("Cloud Storage bucket cleaned")
            self.logger.info("Groundtruth anomaly report generated")
            self.logger.info("Initial workspace copied to agent workspace")
            
            return self._get_instructions(), {}
            
        except Exception as e:
            self.logger.error(f"Error during preprocessing: {e}")
            self.logger.error(traceback.format_exc())
            return self._get_instructions(), {}
    
    def _copy_initial_workspace(self) -> None:
        """Copy initial workspace files to agent workspace."""
        self.logger.info("\nCopying initial workspace to agent workspace...")
        self.logger.info("=" * 60)
        
        try:
            # Source directory (initial workspace template in task_dir)
            initial_workspace_dir = Path(self.task_dir) / "initial_workspace"
            
            # Target directory (agent workspace)
            target_dir = self.agent_workspace
            target_dir.mkdir(parents=True, exist_ok=True)
            
            # Copy all files from initial workspace
            if initial_workspace_dir.exists():
                for item in initial_workspace_dir.iterdir():
                    if item.is_file():
                        shutil.copy2(item, target_dir / item.name)
                        self.logger.info(f"  Copied {item.name} to {target_dir}")
                    elif item.is_dir():
                        shutil.copytree(item, target_dir / item.name, dirs_exist_ok=True)
                        self.logger.info(f"  Copied directory {item.name} to {target_dir}")
            else:
                self.logger.warning(f"  Initial workspace not found: {initial_workspace_dir}")
            
            self.logger.info("Initial workspace files copied successfully")
            
        except Exception as e:
            self.logger.warning(f"Error copying initial workspace files: {e}")
            self.logger.error(traceback.format_exc())

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        """Execute environment step and check agent's anomaly detection results.
        
        Args:
            action: Agent's action (typically triggered by claim_done tool)
        
        Returns:
            Tuple[str, float, bool, bool, Dict[str, Any]]: 
                (observation, reward, terminated, truncated, info)
        """
        super().step(action)
        
        # Import evaluation module using importlib to avoid conflicts
        try:
            import importlib.util
            env_dir = Path(__file__).parent
            evaluation_main_path = env_dir / "evaluation" / "main.py"
            
            # Load module with a unique name to avoid conflicts with other environments
            spec = importlib.util.spec_from_file_location(
                f"machine_operating_s2l_{id(self)}.evaluation_main",
                evaluation_main_path
            )
            evaluation_main_module = importlib.util.module_from_spec(spec)
            
            # Set environment variables before loading
            import os
            os.environ['GOOGLE_CLOUD_DATA_DIR'] = str(self.gcloud_data_dir)
            
            # Set up sys.path before loading
            sys.path.insert(0, str(env_dir / "evaluation"))
            try:
                spec.loader.exec_module(evaluation_main_module)
            finally:
                # Remove from sys.path after loading
                if str(env_dir / "evaluation") in sys.path:
                    sys.path.remove(str(env_dir / "evaluation"))
            
            # Get evaluation functions
            get_gcloud_data_directory = evaluation_main_module.get_gcloud_data_directory
            validate_task_completion = evaluation_main_module.validate_task_completion
            validate_anomaly_reports = evaluation_main_module.validate_anomaly_reports
            generate_validation_summary = evaluation_main_module.generate_validation_summary
            
        except ImportError as e:
            error_msg = f"Failed to import evaluation module: {e}"
            self.logger.error(error_msg)
            return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}
        
        self.logger.info("\n" + "=" * 80)
        self.logger.info("Starting task evaluation")
        self.logger.info("=" * 80)
        
        # Execute evaluation
        try:
            # Import GoogleCloudDatabase
            current_dir = Path(__file__).parent
            sys.path.insert(0, str(current_dir))

            from mcp_convert.mcps.google_cloud.database_utils import GoogleCloudDatabase
            
            # Initialize Google Cloud database
            self.logger.info("\nInitializing Google Cloud Database for evaluation...")
            gcloud_db_dir = str(self.gcloud_data_dir)
            self.logger.info(f"Using Google Cloud Database Directory: {gcloud_db_dir}")
            
            if not Path(gcloud_db_dir).exists():
                error_msg = f"Google Cloud database directory not found: {gcloud_db_dir}"
                self.logger.error(error_msg)
                return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}
            
            gcloud_db = GoogleCloudDatabase(data_dir=gcloud_db_dir)
            
            # Validate task completion - retrieve anomaly report from storage bucket
            groundtruth_workspace = Path(self.task_dir) / "groundtruth_workspace"
            
            self.logger.info("\nValidating anomaly report...")
            
            # Retrieve agent's anomaly report from Cloud Storage bucket
            temp_agent_file = validate_task_completion(
                gcloud_db, 
                bucket_name="iot_anomaly_reports",
                file_pattern="anomaly_report"
            )
            
            # Find groundtruth file
            groundtruth_file = groundtruth_workspace / "anomaly_report.csv"
            if not groundtruth_file.exists():
                error_msg = f"Groundtruth file not found: {groundtruth_file}"
                self.logger.error(error_msg)
                return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}
            
            self.logger.info(f"Agent file (from bucket): {temp_agent_file}")
            self.logger.info(f"Groundtruth file: {groundtruth_file}")
            
            # Validate anomaly reports with bidirectional matching
            validation_results = validate_anomaly_reports(
                temp_agent_file,
                str(groundtruth_file),
                time_tolerance_seconds=60,
                reading_tolerance=0.01
            )
            
            # Generate validation summary
            validation_passed = generate_validation_summary(validation_results)
            
            # Clean up temporary file
            import os
            if os.path.exists(temp_agent_file):
                os.unlink(temp_agent_file)
                self.logger.info(f"Cleaned up temporary file: {temp_agent_file}")
            
            # If validation passed, return success
            if validation_passed:
                observation = self._create_success_observation()
                reward = 1.0
                info = {
                    "success": True,
                    "error": None,
                    "evaluation": "passed"
                }
            else:
                error_msg = "Anomaly report validation failed. Check precision and recall requirements."
                observation = self._create_failure_observation(error_msg)
                reward = 0.0
                info = {
                    "success": False,
                    "error": error_msg,
                    "evaluation": "failed"
                }
                
        except Exception as e:
            error_msg = f"Evaluation error: {str(e)}"
            self.logger.error(error_msg)
            self.logger.error(traceback.format_exc())
            
            observation = self._create_failure_observation(error_msg)
            reward = 0.0
            info = {
                "success": False,
                "error": error_msg,
                "evaluation": "failed"
            }
        
        # Terminate environment
        terminated = True
        truncated = False
        
        return observation, reward, terminated, truncated, info
    
    def _create_success_observation(self) -> str:
        """Create success observation message.
        
        Returns:
            str: Formatted success message
        """
        return (
            "\n" + "=" * 80 + "\n"
            "Task Evaluation Result: Success!\n"
            "=" * 80 + "\n"
            "All checks passed:\n"
            "  ✓ Anomaly report correctly uploaded to Cloud Storage bucket\n"
            "  ✓ All anomalies identified with correct timestamps\n"
            "  ✓ Machine IDs and sensor types match exactly\n"
            "  ✓ Readings are accurate within tolerance\n"
            "  ✓ Normal ranges are correctly formatted\n"
            "  ✓ Precision and recall both meet 100% requirement\n"
            "\nCongratulations! You have successfully completed the machine operating anomaly detection task.\n"
            "=" * 80 + "\n"
        )
    
    def _create_failure_observation(self, error: str) -> str:
        """Create failure observation message.
        
        Args:
            error: Error message describing what failed
        
        Returns:
            str: Formatted failure message
        """
        return (
            "\n" + "=" * 80 + "\n"
            "Task Evaluation Result: Failed\n"
            "=" * 80 + "\n"
            f"Error details:\n{error}\n"
            "\nPlease review and fix the issues above.\n"
            "Hints:\n"
            "  - Did you query the correct time range (11:30-12:30 on Aug 19, 2025)?\n"
            "  - Did you compare readings against machine_operating_parameters.xlsx?\n"
            "  - Did you include all required fields: timestamp, machine_id, sensor_type, reading, normal_range?\n"
            "  - Did you upload the file to the 'iot_anomaly_reports' bucket?\n"
            "  - Are the timestamp formats exactly matching the BigQuery data?\n"
            "=" * 80 + "\n"
        )
    
    def _create_error_observation(self, error_msg: str) -> str:
        """Create error observation message for evaluation errors.
        
        Args:
            error_msg: Error message describing the evaluation error
        
        Returns:
            str: Formatted error message
        """
        return (
            "\n" + "=" * 80 + "\n"
            "Task Evaluation Error\n"
            "=" * 80 + "\n"
            f"Error details:\n{error_msg}\n"
            "=" * 80 + "\n"
        )



