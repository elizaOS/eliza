# Standard library imports
import logging
import shutil
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

# Local imports
from gem.core import Env
from mcp_convert.mcps.canvas.database_utils import CanvasDatabase
from gem.utils.constants import TERMINAL_STATE
from gem.utils.filesystem import nfs_safe_rmtree

# Constants
TASK_INSTRUCTION = '''It is exam week now, and today is January 15, 2025. Check the announcements in Canvas or Emails (already logined in) for information and compile a list of the remaining final exams I need to take. (To reduce the burden at the end of the semester, please only list the final exams I must attend) Please fill in the table `exam_schedule.xlsx` under the workspace; the column names have already been provided, do not change the file name after filling in it. Sort the final exam information in order of exam start time, from nearest to farthest. Remove the “-x” suffix from course codes and course names.  Do not include courses that have already ended, that I do not need to attend, or that explicitly state there is no final exam.  The table must list all courses that have not yet ended, that I need to take, and that do not explicitly state there is no final exam. By default, the proctor is the course instructor. If any exam information has not yet been released, mark the cell as TBD. When filling in the table, completely preserve the original table headers.  '''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'

# File names
EXAM_SCHEDULE_XLSX = "exam_schedule.xlsx"


class CanvasArrangeExamS2LEnv(Env):
    """Canvas Arrange Exam S2L Environment for managing exam schedules.
    
    This environment simulates a Canvas LMS scenario where students need to
    organize exam information from announcements and emails into an Excel file.
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        num_courses: int = 10,
        canvas_exam_rate: float = 0.7,
        email_exam_rate: float = 0.2,
        no_exam_rate: float = 0.1,
        tbd_rate: float = 0.0, # Plz do not include TDB, just include the exam information that has been released.
        exemption_rate: float = 0.0,
        past_exam_rate: float = 0.0,
        distraction_emails: int = 3,
        distraction_announcements: int = 2,
        difficulty: str = "medium",
        seed: int = 42,
        verbose: bool = False,
        **_,
    ):
        """Initialize the Canvas Arrange Exam S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            num_courses: Number of courses to generate
            canvas_exam_rate: Probability of exam via Canvas announcement
            email_exam_rate: Probability of exam via Email
            no_exam_rate: Probability of no final exam
            tbd_rate: Probability of TBD exam info
            exemption_rate: Probability of exemption (not used, set to 0)
            past_exam_rate: Probability of past exams
            distraction_emails: Number of distraction emails
            distraction_announcements: Number of distraction announcements per course
            difficulty: Difficulty level (easy/medium/hard/expert)
            seed: Random seed for reproducibility
            verbose: Whether to output to console
        """
        super().__init__()
        self.task_dir = task_dir
        self.verbose = verbose

        # Setup directory paths
        self.agent_workspace = Path(self.task_dir) / "agent_workspace"
        self.data_dir = Path(self.task_dir) / "local_db"
        self.canvas_data_dir = self.data_dir / "canvas"
        self.email_data_dir = self.data_dir / "emails"

        # Clear task directory if it exists, then create it
        if Path(self.task_dir).exists():
            nfs_safe_rmtree(self.task_dir)
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        
        # Setup logging system
        self._setup_logging()

        # Initialize database and file paths
        self.db = CanvasDatabase(data_dir=self.canvas_data_dir)
        #self.email_db = EmailDatabase(data_dir=self.email_data_dir)
        self.config_file = Path(self.task_dir) / "files" / "course_config.json"
        self.email_config_file = Path(self.task_dir) / "files" / "email_config.json"
        self.users_file = Path(self.task_dir) / "files" / "canvas_users.json"
        self.account_id = 1  # Default account
        
        # Configuration generation parameters
        self.num_courses = num_courses
        self.canvas_exam_rate = canvas_exam_rate
        self.email_exam_rate = email_exam_rate
        self.no_exam_rate = no_exam_rate
        self.tbd_rate = tbd_rate
        self.exemption_rate = exemption_rate
        self.past_exam_rate = past_exam_rate
        self.distraction_emails = distraction_emails
        self.distraction_announcements = distraction_announcements
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
        self.logger = logging.getLogger(f"CanvasArrangeExamS2L_{id(self)}")
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
        """Reset environment and execute Canvas exam arrangement preprocessing.
        
        Steps include:
        1. Generate exam data (courses, announcements, emails)
        2. Clear local database
        3. Create Canvas courses with exam announcements
        4. Inject exam notification emails
        5. Copy initial Excel template to agent workspace
        
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

            # Reinitialize database and file paths
            self.db = CanvasDatabase(data_dir=self.canvas_data_dir)

            self.logger.info("Starting Canvas exam arrangement preprocessing...")
            self.logger.info("=" * 60)
            
            # Import preprocessing module using importlib to avoid conflicts
            try:
                import importlib.util
                env_dir = Path(__file__).parent
                main_path = env_dir / "main.py"
                
                # Load module with a unique name to avoid conflicts with other environments
                spec = importlib.util.spec_from_file_location(
                    "canvas_arrange_exam_s2l.main",
                    main_path
                )
                main_module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(main_module)
                
                run_preprocessing = main_module.run_preprocessing
            except ImportError as e:
                self.logger.warning(f"Could not import preprocessing module: {e}")
                self.logger.warning(f"Looked in: {env_dir}")
                return self._get_instructions(), {}
            
            # Run preprocessing with all parameters
            self.logger.info("\nRunning preprocessing pipeline...")
            self.logger.info("=" * 60)
            success = run_preprocessing(
                agent_workspace=str(self.agent_workspace),
                task_dir=self.task_dir,
                seed=self.seed,
                num_courses=self.num_courses,
                canvas_exam_rate=self.canvas_exam_rate,
                email_exam_rate=self.email_exam_rate,
                no_exam_rate=self.no_exam_rate,
                tbd_rate=self.tbd_rate,
                exemption_rate=self.exemption_rate,
                past_exam_rate=self.past_exam_rate,
                distraction_emails=self.distraction_emails,
                distraction_announcements=self.distraction_announcements,
                difficulty=self.difficulty
            )
            
            if not success:
                self.logger.error("Preprocessing failed")
                return self._get_instructions(), {}
            
            # Reload database to get latest data
            self.logger.info("\nReloading database...")
            self.db = CanvasDatabase(data_dir=self.canvas_data_dir)
            self.logger.info("Database reloaded successfully")
            self.logger.info(f"  - Courses: {len(self.db.courses)}")
            self.logger.info(f"  - Users: {len(self.db.users)}")
            self.logger.info(f"  - Announcements: {len(self.db.announcements)}")
            
            self.logger.info("\nCanvas exam arrangement preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("Configuration files generated")
            self.logger.info("Local database cleared and reinitialized")
            self.logger.info("All courses created and published")
            self.logger.info("Exam notification emails injected")
            self.logger.info("Initial Excel template copied to agent workspace")
            self.logger.info("\nUsing local JSON database, no Canvas API required")
            
            return self._get_instructions(), {}
            
        except Exception as e:
            self.logger.error(f"Error during preprocessing: {e}")
            self.logger.error(traceback.format_exc())
            return self._get_instructions(), {}

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        """Execute environment step and check agent workspace against groundtruth.
        
        Args:
            action: Agent's action (typically triggered by claim_done tool)
        
        Returns:
            Tuple[str, float, bool, bool, Dict[str, Any]]: 
                (observation, reward, terminated, truncated, info)
        """
        super().step(action)
        
        # Import check_local function using importlib to avoid conflicts
        try:
            import importlib.util
            env_dir = Path(__file__).parent
            check_local_path = env_dir / "check_local.py"
            
            # Load module with a unique name to avoid conflicts with other environments
            spec = importlib.util.spec_from_file_location(
                "canvas_arrange_exam_s2l.check_local",
                check_local_path
            )
            check_local_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(check_local_module)
            
            check_local = check_local_module.check_local
        except ImportError as e:
            error_msg = f"Failed to import check_local: {e}"
            self.logger.error(error_msg)
            return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}
        
        # Define paths
        agent_workspace = str(self.agent_workspace)
        groundtruth_workspace = str(Path(self.task_dir) / "groundtruth_workspace")
        
        self.logger.info("\n" + "=" * 80)
        self.logger.info("Starting task evaluation")
        self.logger.info("=" * 80)
        self.logger.info(f"Agent Workspace: {agent_workspace}")
        self.logger.info(f"Groundtruth Workspace: {groundtruth_workspace}")
        
        # Execute check
        try:
            success, error = check_local(agent_workspace, groundtruth_workspace)
            
            if success:
                observation = self._create_success_observation()
                reward = 1.0
                info = {
                    "success": True,
                    "error": None,
                    "evaluation": "passed"
                }
            else:
                observation = self._create_failure_observation(error)
                reward = 0.0
                info = {
                    "success": False,
                    "error": error,
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
            "  File integrity: Passed\n"
            "  Time ordering: Passed\n"
            "  Content matching: Passed\n"
            "  All exam information correct: Passed\n"
            "\nCongratulations! You have successfully completed the exam schedule organization.\n"
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

