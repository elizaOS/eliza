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
TASK_INSTRUCTION = '''The academic affairs system requires an automated academic warning mechanism. The latest unit test scores are recorded in the `latest_quiz_scores.csv` file. Please read this file and combine it with all the student scores stored in multiple test score tables in the `academic_warning` dataset of BigQuery to identify those students whose test scores have dropped by more than 25% compared to their average scores in the past. Write the list to the  `bad_student.csv`. For those students whose test scores have dropped by more than 45%, please immediately write a critical level warning log to the `exam_log` log storage bucket for each of them with his/her name and student ID so that the system can automatically notify their counselor.'''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'


class AcademicWarningS2LEnv(Env):
    """Academic Warning S2L Environment for identifying at-risk students.
    
    This environment simulates an educational scenario where the agent needs to
    query historical exam data from BigQuery, compare with latest quiz scores,
    and identify students with significant performance decline.
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        num_students: int = 150,
        num_exams: int = 7,
        difficulty: str = "medium",
        seed: int = 42,
        verbose: bool = False,
        **_,
    ):
        """Initialize the Academic Warning S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            num_students: Number of students to generate (default: 150)
            num_exams: Number of historical exams (default: 7)
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
        self.num_students = num_students
        self.num_exams = num_exams
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
        self.logger = logging.getLogger(f"AcademicWarningS2L_{id(self)}")
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
        """Reset environment and execute Academic Warning preprocessing.
        
        Steps include:
        1. Generate academic warning data (CSV files for historical exams)
        2. Generate latest quiz scores
        3. Calculate groundtruth for students with >25% score drop
        4. Clean and initialize BigQuery dataset (academic_warning)
        5. Clean and initialize Cloud Logging (exam_log)
        6. Upload historical exam data to BigQuery
        7. Copy latest quiz scores to agent workspace
        
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

            self.logger.info("Starting Academic Warning preprocessing...")
            self.logger.info("=" * 60)
            
            # Import preprocessing module using importlib to avoid conflicts
            try:
                import importlib.util
                env_dir = Path(__file__).parent
                preprocess_main_path = env_dir / "preprocess" / "main.py"
                
                # Load module with a unique name to avoid conflicts with other environments
                spec = importlib.util.spec_from_file_location(
                    f"academic_warning_s2l_{id(self)}.preprocess_main",
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
                
                # Create temporary task root for preprocessing
                temp_task_root = Path(self.task_dir) / "temp_preprocess"
                temp_task_root.mkdir(parents=True, exist_ok=True)
                
                # Copy generate_academic_data.py to temp task root
                source_generator = env_dir / "generate_academic_data.py"
                dest_generator = temp_task_root / "generate_academic_data.py"
                shutil.copy2(source_generator, dest_generator)
                
                # Set up environment variable for Google Cloud data directory
                import os
                env = os.environ.copy()
                env['GOOGLE_CLOUD_DATA_DIR'] = str(self.gcloud_data_dir)
                
                cmd = [
                    sys.executable,
                    str(preprocess_main_path),
                    "--agent_workspace", str(self.agent_workspace),
                    "--num-students", str(self.num_students),
                    "--num-exams", str(self.num_exams),
                    "--difficulty", self.difficulty,
                    "--seed", str(self.seed)
                ]
                
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd=str(temp_task_root),
                    env=env
                )
                
                if result.stdout:
                    self.logger.info(result.stdout)
                
                if result.returncode != 0:
                    self.logger.error("Preprocessing failed")
                    if result.stderr:
                        self.logger.error(result.stderr)
                    return self._get_instructions(), {}
                
                # Move generated files to proper locations
                self._organize_generated_files(temp_task_root)
                
                # Clean up temp directory
                nfs_safe_rmtree(temp_task_root)
                
            except Exception as e:
                self.logger.error(f"Error running preprocessing: {e}")
                self.logger.error(traceback.format_exc())
                return self._get_instructions(), {}
            
            self.logger.info("\nAcademic Warning preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("Academic data generated")
            self.logger.info("BigQuery dataset initialized and populated")
            self.logger.info("Cloud Logging configured")
            self.logger.info("Groundtruth generated")
            self.logger.info("Latest quiz scores copied to agent workspace")
            
            return self._get_instructions(), {}
            
        except Exception as e:
            self.logger.error(f"Error during preprocessing: {e}")
            self.logger.error(traceback.format_exc())
            return self._get_instructions(), {}
    
    def _organize_generated_files(self, temp_task_root: Path) -> None:
        """Organize generated files from temp directory to proper locations.
        
        Args:
            temp_task_root: Temporary task root directory where files were generated
        """
        self.logger.info("\nOrganizing generated files...")
        self.logger.info("=" * 60)
        
        try:
            # Move files directory
            temp_files = temp_task_root / "files"
            if temp_files.exists():
                dest_files = Path(self.task_dir) / "files"
                if dest_files.exists():
                    nfs_safe_rmtree(dest_files)
                shutil.move(str(temp_files), str(dest_files))
                self.logger.info(f"  Moved files/ to {dest_files}")
            
            # Move initial_workspace directory
            temp_initial = temp_task_root / "initial_workspace"
            if temp_initial.exists():
                dest_initial = Path(self.task_dir) / "initial_workspace"
                if dest_initial.exists():
                    nfs_safe_rmtree(dest_initial)
                shutil.move(str(temp_initial), str(dest_initial))
                self.logger.info(f"  Moved initial_workspace/ to {dest_initial}")
            
            # Move groundtruth_workspace directory
            temp_groundtruth = temp_task_root / "groundtruth_workspace"
            if temp_groundtruth.exists():
                dest_groundtruth = Path(self.task_dir) / "groundtruth_workspace"
                if dest_groundtruth.exists():
                    nfs_safe_rmtree(dest_groundtruth)
                shutil.move(str(temp_groundtruth), str(dest_groundtruth))
                self.logger.info(f"  Moved groundtruth_workspace/ to {dest_groundtruth}")
            
            self.logger.info("Files organized successfully")
            
        except Exception as e:
            self.logger.warning(f"Error organizing files: {e}")
            self.logger.error(traceback.format_exc())

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        """Execute environment step and check agent's academic warning results.
        
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
                f"academic_warning_s2l_{id(self)}.evaluation_main",
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
            read_student_data = evaluation_main_module.read_student_data
            get_students_above_threshold = evaluation_main_module.get_students_above_threshold
            check_critical_logs_for_students = evaluation_main_module.check_critical_logs_for_students
            get_all_students = evaluation_main_module.get_all_students
            
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
            
            # Define paths
            agent_needed_file = self.agent_workspace / "bad_student.csv"
            groundtruth_workspace = Path(self.task_dir) / "groundtruth_workspace"
            agent_groundtruth_file = groundtruth_workspace / "expected_alerts.csv"
            files_dir = Path(self.task_dir) / "files"
            
            self.logger.info("\nValidating bad_student.csv and logs...")
            
            # Validate file existence
            if not agent_needed_file.exists():
                error_msg = f"Missing agent output file: {agent_needed_file}"
                self.logger.error(error_msg)
                return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}
            
            if not agent_groundtruth_file.exists():
                error_msg = f"Missing groundtruth file: {agent_groundtruth_file}"
                self.logger.error(error_msg)
                return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}
            
            # Read ground truth data
            self.logger.info("1. Reading ground truth data...")
            gt_data = read_student_data(str(agent_groundtruth_file))
            self.logger.info(f"Ground truth contains {len(gt_data)} students")
            
            # Read agent output data
            self.logger.info("2. Reading agent output data...")
            try:
                agent_data = read_student_data(str(agent_needed_file))
                self.logger.info(f"Agent output contains {len(agent_data)} students")
            except Exception as e:
                self.logger.error(f"Error reading agent output: {e}")
                # Fallback: just read student IDs
                import csv
                with open(agent_needed_file, 'r', encoding='utf-8', newline='') as f:
                    reader = csv.DictReader(f)
                    agent_ids = [row.get("student_id", "").strip() for row in reader if row.get("student_id", "").strip()]
                agent_data = {sid: {"drop_ratio": 0.3} for sid in agent_ids}
            
            # Determine expected students for different thresholds
            self.logger.info("3. Analyzing thresholds...")
            gt_25_percent = get_students_above_threshold(gt_data, 0.25)
            gt_45_percent = get_students_above_threshold(gt_data, 0.45)
            all_students = get_all_students(files_dir)
            all_below_45_percent = [x for x in all_students if x not in gt_45_percent]
            
            self.logger.info(f"Students with >25% drop (should be in bad_student.csv): {len(gt_25_percent)}")
            self.logger.info(f"Students with >45% drop (should have CRITICAL logs): {len(gt_45_percent)}")
            
            # Validate bad_student.csv with 100% accuracy requirement
            self.logger.info("4. Validating bad_student.csv with 100% accuracy...")
            agent_ids = set(agent_data.keys())
            gt_25_set = set([item[0] for item in gt_25_percent])
            
            # Check for exact match
            is_exact_match = agent_ids == gt_25_set
            accuracy = 1.0 if is_exact_match else 0.0
            
            self.logger.info(f"Agent selected {len(agent_ids)} students")
            self.logger.info(f"Ground truth has {len(gt_25_set)} students with >25% drop")
            self.logger.info(f"Exact match: {is_exact_match}")
            self.logger.info(f"Accuracy: {accuracy:.2%}")
            
            if not is_exact_match:
                missing_in_agent = sorted(gt_25_set - agent_ids)
                extra_in_agent = sorted(agent_ids - gt_25_set)
                error_msg = f"bad_student.csv does not exactly match ground truth (accuracy: {accuracy:.2%})"
                if missing_in_agent:
                    error_msg += f"\nMissing students (in GT but not in agent): {missing_in_agent[:5]}"
                if extra_in_agent:
                    error_msg += f"\nIncorrect students (in agent but not in GT): {extra_in_agent[:5]}"
                
                observation = self._create_failure_observation(error_msg)
                reward = 0.0
                info = {
                    "success": False,
                    "error": error_msg,
                    "evaluation": "failed"
                }
            else:
                self.logger.info(f"✅ bad_student.csv accuracy {accuracy:.2%} meets 100% threshold")
                
                # Check local database logs for students above 45% threshold
                self.logger.info("5. Checking local database logs for students with >45% drop...")
                logs_valid = check_critical_logs_for_students(gcloud_db, gt_45_percent, all_below_45_percent)
                
                if not logs_valid:
                    error_msg = "Critical log validation failed. Not all students with >45% drop have CRITICAL logs."
                    observation = self._create_failure_observation(error_msg)
                    reward = 0.0
                    info = {
                        "success": False,
                        "error": error_msg,
                        "evaluation": "failed"
                    }
                else:
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
            "  ✓ bad_student.csv contains exactly the right students (100% accuracy)\n"
            "  ✓ All students with >25% score drop are identified\n"
            "  ✓ CRITICAL logs written for all students with >45% drop\n"
            "  ✓ No false positives or missing students\n"
            "\nCongratulations! You have successfully completed the academic warning task.\n"
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
            "  - Did you query all historical exam tables (exam_2501 to exam_2507)?\n"
            "  - Did you calculate the average correctly from historical data?\n"
            "  - Did you identify students with >25% drop for bad_student.csv?\n"
            "  - Did you write CRITICAL logs for students with >45% drop?\n"
            "  - Did you ensure students have at least 3 historical records?\n"
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



