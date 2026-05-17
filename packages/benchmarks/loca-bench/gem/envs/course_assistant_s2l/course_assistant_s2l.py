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
TASK_INSTRUCTION = '''I am the teaching assistant for the NLP course. The final presentation assignments from the students are now in my email (my email account information is in email_account.txt in the workspace). All the statistical data for this course is located in the Excel file named `nlp_statistics.xlsx` within the workspace. Please help me compile the statistics, identify who has not yet submitted this assignment, and send each of them an email. Please disregard any students who have already withdrawn from the course. The subject of the email should be "nlp-course-emergency," and the content must include the student's name and ID number to prevent it from being marked as spam.'''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'


class CourseAssistantS2LEnv(Env):
    """Course Assistant S2L Environment for managing student assignment reminders.
    
    This environment simulates a teaching assistant scenario where the agent needs to
    check student submission status and send reminder emails to students who haven't submitted.
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        num_students: int = 15,
        dropout_rate: float = 0.1,
        submission_rate: float = 0.7,
        num_check: int = 2,
        seed: int = 42,
        verbose: bool = False,
        **_,
    ):
        """Initialize the Course Assistant S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            num_students: Number of students to generate
            dropout_rate: Probability of student dropping the course
            submission_rate: Probability of student submitting assignment
            num_check: Number of students to check (deprecated, kept for compatibility)
            seed: Random seed for reproducibility
            verbose: Whether to output to console
        """
        super().__init__()
        self.task_dir = task_dir
        self.verbose = verbose

        # Setup directory paths
        self.agent_workspace = Path(self.task_dir) / "agent_workspace"
        self.data_dir = Path(self.task_dir) / "local_db"
        self.email_data_dir = self.data_dir / "emails"

        # Clear task directory if it exists, then create it
        if Path(self.task_dir).exists():
            nfs_safe_rmtree(self.task_dir)
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        
        # Setup logging system
        self._setup_logging()

        # Configuration generation parameters
        self.num_students = num_students
        self.dropout_rate = dropout_rate
        self.submission_rate = submission_rate
        self.num_check = num_check
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
        self.logger = logging.getLogger(f"CourseAssistantS2L_{id(self)}")
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
        """Reset environment and execute Course Assistant preprocessing.
        
        Steps include:
        1. Generate task configuration (Excel roster, email submissions)
        2. Initialize email database
        3. Clear email inboxes
        4. Send student submission emails
        5. Save instructor email credentials
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

            self.logger.info("Starting Course Assistant preprocessing...")
            self.logger.info("=" * 60)
            
            # Import preprocessing module using importlib to avoid conflicts
            try:
                import importlib.util
                env_dir = Path(__file__).parent
                preprocess_main_path = env_dir / "preprocess" / "main.py"
                
                # Load module with a unique name to avoid conflicts with other environments
                spec = importlib.util.spec_from_file_location(
                    f"course_assistant_s2l_{id(self)}.preprocess_main",
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
            
            # Call the preprocessing as a function
            try:
                # Import subprocess for running the preprocessing script
                import subprocess
                
                cmd = [
                    sys.executable,
                    str(preprocess_main_path),
                    "--task-root", str(self.task_dir),
                    "--agent_workspace", str(self.agent_workspace),
                    "--num-students", str(self.num_students),
                    "--dropout-rate", str(self.dropout_rate),
                    "--submission-rate", str(self.submission_rate),
                    "--num-check", str(self.num_check),
                    "--seed", str(self.seed)
                ]
                
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd=str(Path(__file__).parent)
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
            
            self.logger.info("\nCourse Assistant preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("Configuration files generated")
            self.logger.info("Email database initialized")
            self.logger.info("Student submission emails sent")
            self.logger.info("Instructor email credentials saved")
            self.logger.info("Initial workspace copied to agent workspace")
            
            return self._get_instructions(), {}
            
        except Exception as e:
            self.logger.error(f"Error during preprocessing: {e}")
            self.logger.error(traceback.format_exc())
            return self._get_instructions(), {}

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        """Execute environment step and check agent's email sending results.
        
        Args:
            action: Agent's action (typically triggered by claim_done tool)
        
        Returns:
            Tuple[str, float, bool, bool, Dict[str, Any]]: 
                (observation, reward, terminated, truncated, info)
        """
        super().step(action)
        
        # Import check_local module using importlib to avoid conflicts
        try:
            import importlib.util
            env_dir = Path(__file__).parent
            check_local_path = env_dir / "evaluation" / "check_local.py"
            
            # Load module with a unique name to avoid conflicts with other environments
            spec = importlib.util.spec_from_file_location(
                f"course_assistant_s2l_{id(self)}.check_local",
                check_local_path
            )
            check_local_module = importlib.util.module_from_spec(spec)
            
            # Set environment variables before loading
            import os
            os.environ['EMAIL_DATA_DIR'] = str(self.email_data_dir)
            os.environ['TASK_DIR'] = str(self.task_dir)
            
            # Set up sys.path before loading
            sys.path.insert(0, str(env_dir / "evaluation"))
            try:
                spec.loader.exec_module(check_local_module)
            finally:
                # Remove from sys.path after loading
                if str(env_dir / "evaluation") in sys.path:
                    sys.path.remove(str(env_dir / "evaluation"))
            
            check_local_main = check_local_module.main
        except ImportError as e:
            error_msg = f"Failed to import check_local: {e}"
            self.logger.error(error_msg)
            return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}
        
        self.logger.info("\n" + "=" * 80)
        self.logger.info("Starting task evaluation")
        self.logger.info("=" * 80)
        
        # Execute check
        try:
            success = check_local_main()
            
            if success:
                observation = self._create_success_observation()
                reward = 1.0
                info = {
                    "success": True,
                    "error": None,
                    "evaluation": "passed"
                }
            else:
                observation = self._create_failure_observation(
                    "Some students did not receive correct reminder emails. "
                    "Please check the logs for details."
                )
                reward = 0.0
                info = {
                    "success": False,
                    "error": "Email verification failed",
                    "evaluation": "failed"
                }
                
        except Exception as e:
            error_msg = f"Evaluation error: {str(e)}"
            self.logger.error(error_msg)
            self.logger.error(traceback.format_exc())
            
            observation = self._create_error_observation(error_msg)
            reward = 0.0
            info = {
                "success": False,
                "error": error_msg,
                "evaluation": "error"
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
            "  ✓ All enrolled students who have not submitted received reminder emails\n"
            "  ✓ Email subjects are correct: 'nlp-course-emergency'\n"
            "  ✓ Email contents include student names and IDs\n"
            "  ✓ No emails sent to students who already submitted\n"
            "  ✓ No emails sent to dropped students\n"
            "\nCongratulations! You have successfully completed the teaching assistant task.\n"
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
            "  - Did you identify all students who have not submitted?\n"
            "  - Are email subjects exactly 'nlp-course-emergency'?\n"
            "  - Do email contents include both student name and ID?\n"
            "  - Did you avoid sending to dropped or already-submitted students?\n"
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

