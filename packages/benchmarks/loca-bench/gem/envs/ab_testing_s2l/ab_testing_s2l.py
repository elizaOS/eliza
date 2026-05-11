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
TASK_INSTRUCTION = '''The A/B test for our new homepage has concluded, and the raw clickstream data has been stored in the `ab_testing` dataset in BigQuery. Analyze this data to calculate the conversion rate for each scenario as well as the overall conversion rate, which should be labeled `overall (total_store_views/total_clicks)`. Record these results in `record.csv`, following the same format used in that file — do not change column names. After completing the analysis, determine which version ('A' or 'B') has the highest overall conversion rate, i.e., the overall conversion rate is defined as the arithmetic mean of the per-scenario conversion rates. If version B outperforms, immediately create a new Cloud Storage bucket named `promo-assets-for-b` for the full promotion, and you do not need to write any log entry in this process. If version A wins or the results are a tie, no bucket creation is required, but a log entry with the message `{'status': 'AB_Test_Concluded', 'winner': 'A', 'action': 'No_Change'}` must be written to the `abtesting_logging` bucket. '''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'


class ABTestingS2LEnv(Env):
    """A/B Testing S2L Environment for analyzing conversion rates.
    
    This environment simulates an A/B testing scenario where the agent needs to
    analyze clickstream data from BigQuery, calculate conversion rates, and take
    appropriate actions based on test results.
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        num_scenarios: int = 50,
        num_days: int = 15,
        difficulty: str = "medium",
        seed: int = 42,
        verbose: bool = False,
        **_,
    ):
        """Initialize the A/B Testing S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            num_scenarios: Number of scenarios to generate
            num_days: Number of days per scenario
            difficulty: Difficulty level (easy/medium/hard)
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
        self.num_scenarios = num_scenarios
        self.num_days = num_days
        self.difficulty = difficulty
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
        self.logger = logging.getLogger(f"ABTestingS2L_{id(self)}")
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
        """Reset environment and execute A/B testing preprocessing.
        
        Steps include:
        1. Generate A/B test data (CSV files)
        2. Clean and initialize BigQuery dataset (ab_testing)
        3. Clean and initialize Cloud Storage bucket (promo-assets-for-b)
        4. Setup Cloud Logging (abtesting_logging)
        5. Upload CSV files to BigQuery
        6. Copy initial workspace to agent workspace
        
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

            self.logger.info("Starting A/B Testing preprocessing...")
            self.logger.info("=" * 60)
            
            # Import preprocessing module using importlib to avoid conflicts
            try:
                import importlib.util
                env_dir = Path(__file__).parent
                preprocess_main_path = env_dir / "preprocess" / "main.py"
                
                # Load module with a unique name to avoid conflicts with other environments
                spec = importlib.util.spec_from_file_location(
                    f"ab_testing_s2l_{id(self)}.preprocess_main",
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
                    "--num-scenarios", str(self.num_scenarios),
                    "--num-days", str(self.num_days),
                    "--difficulty", self.difficulty,
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
            
            self.logger.info("\nA/B Testing preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("A/B test data generated")
            self.logger.info("BigQuery dataset initialized and populated")
            self.logger.info("Cloud Storage bucket cleaned")
            self.logger.info("Cloud Logging configured")
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
            # Source directory (initial workspace template)
            initial_workspace_dir = Path(__file__).parent / "initial_workspace"
            
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
        """Execute environment step and check agent's A/B testing results.
        
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
                f"ab_testing_s2l_{id(self)}.evaluation_main",
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
            read_record_csv = evaluation_main_module.read_record_csv
            load_expected_records = evaluation_main_module.load_expected_records
            validate_record_data = evaluation_main_module.validate_record_data
            validate_task_completion = evaluation_main_module.validate_task_completion
            get_gcloud_data_directory = evaluation_main_module.get_gcloud_data_directory
            
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
            #from gem.tools.mcp_server.google_cloud.database import GoogleCloudDatabase



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
            
            # Validate record.csv file
            agent_record_file = self.agent_workspace / "record.csv"
            groundtruth_workspace = Path(self.task_dir) / "groundtruth_workspace"
            
            self.logger.info("\nValidating record.csv...")
            
            # Load actual and expected records
            actual_records = read_record_csv(str(agent_record_file))
            expected_records = load_expected_records(str(groundtruth_workspace))
            
            self.logger.info(f"Found {len(actual_records)} scenarios in agent's record.csv")
            self.logger.info(f"Expected {len(expected_records)} scenarios from groundtruth")
            
            # Validate with 0.05% tolerance
            validate_record_data(actual_records, expected_records, tolerance_pct=0.05)
            self.logger.info("Record validation passed")
            
            # Validate task completion based on A/B test results
            validate_task_completion(gcloud_db, actual_records)
            
            # If we reach here, validation succeeded
            observation = self._create_success_observation()
            reward = 1.0
            info = {
                "success": True,
                "error": None,
                "evaluation": "passed"
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
            "  ✓ Record.csv contains correct conversion rates for all scenarios\n"
            "  ✓ Overall conversion rate is calculated correctly\n"
            "  ✓ Appropriate action taken based on A/B test winner\n"
            "  ✓ Cloud Storage bucket and/or logging configured correctly\n"
            "\nCongratulations! You have successfully completed the A/B testing analysis.\n"
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
            "  - Did you calculate conversion rates correctly for all scenarios?\n"
            "  - Is the overall conversion rate labeled correctly?\n"
            "  - Did you take the appropriate action based on the winner?\n"
            "  - If B wins: create bucket 'promo-assets-for-b', no log entry\n"
            "  - If A wins/tie: no bucket, write log entry to abtesting_logging\n"
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


