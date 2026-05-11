# Standard library imports
import logging
import shutil
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

# Third-party imports
import pandas as pd

# Local imports
from gem.core import Env
from mcp_convert.mcps.canvas.database_utils import CanvasDatabase
from gem.utils.constants import TERMINAL_STATE
from gem.utils.filesystem import nfs_safe_rmtree

# Constants
TASK_INSTRUCTION = '''My personal information is all stored in memory. Based on the course information on Canvas, as well as my assignment and quiz submission status. Find all my unfinished course assignments and quizzes that have to be completed (find all assignments and quizzes that I must submit, as according to information released by the teachers in announcements, some content may not need to be submitted), organize the information according to the required fields in the workspace's CSV header, keeping the format consistent with these examples, and complete these CSV files. In filling the files, please fill the quizzes/assignments in chronological order by their deadlines (DDL), and for quizzes/assignmen with the same DDL, sort them in the dictionary order of the class code. You should directly edit in the given 2 CSV files without changing their file names.'''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'

# File names
QUIZ_INFO_CSV = "quiz_info.csv"
ASSIGNMENT_INFO_CSV = "assignment_info.csv"

class CanvasListTestS2LEnv(Env):
    """Canvas List Test S2L Environment for managing course assignments and quizzes.
    
    This environment simulates a Canvas LMS testing scenario where students need to
    organize their unfinished course assignments and quizzes into CSV files.
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        num_courses: int = 10,
        num_students: int = 3,
        quiz_prob: float = 0.8,
        assignment_prob: float = 0.7,
        submission_prob: float = 0.1,
        exemption_prob: float = 0.1,
        exemption_meet_prob: float = 0.6,
        no_exam_prob: float = 0.15,
        quiz_difficulty: str = "medium",
        assignment_difficulty: str = "medium",
        seed: int = 42,
        verbose: bool = False,
        **_,
    ):
        """Initialize the Canvas List Test S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            num_courses: Number of courses to generate
            num_students: Number of students to simulate
            quiz_prob: Probability of quiz generation
            assignment_prob: Probability of assignment generation
            submission_prob: Probability of submission
            exemption_prob: Probability of exemption
            exemption_meet_prob: Probability of meeting exemption criteria
            no_exam_prob: Probability of no exam requirement
            quiz_difficulty: Difficulty level for quizzes
            assignment_difficulty: Difficulty level for assignments
            seed: Random seed for reproducibility
            verbose: Whether to output to console
        """
        super().__init__()
        self.task_dir = task_dir
        self.exemption_courses: Dict[str, Any] = {}
        self.verbose = verbose

        # Setup directory paths
        self.agent_workspace = Path(self.task_dir) / "agent_workspace"
        self.data_dir = Path(self.task_dir) / "local_db"
        self.canvas_data_dir = self.data_dir / "canvas"

        # Clear task directory if it exists, then create it
        if Path(self.task_dir).exists():
            nfs_safe_rmtree(self.task_dir)
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        
        # Setup logging system
        self._setup_logging()

        # Initialize database and file paths
        self.db = CanvasDatabase(data_dir=self.canvas_data_dir)
        self.config_file = Path(self.task_dir) / "files" / "course_config.json"
        self.users_file = Path(self.task_dir) / "files" / "canvas_users.json"
        self.courses_data: Optional[Dict[str, Any]] = None
        self.users_data: Optional[Dict[str, Any]] = None
        self.account_id = 1  # Default account
        
        # Configuration generation parameters
        self.num_courses = num_courses
        self.num_students = num_students
        self.quiz_prob = quiz_prob
        self.assignment_prob = assignment_prob
        self.submission_prob = submission_prob
        self.exemption_prob = exemption_prob
        self.exemption_meet_prob = exemption_meet_prob
        self.no_exam_prob = no_exam_prob
        self.quiz_difficulty = quiz_difficulty
        self.assignment_difficulty = assignment_difficulty
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
        self.logger = logging.getLogger(f"CanvasListTestS2L_{id(self)}")
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

    def generate_config(self) -> Optional[Dict[str, Any]]:
        """Generate task configuration using initialization parameters.
        
        Returns:
            Optional[Dict[str, Any]]: Configuration generation statistics,
                                     or None if generation failed
        """
        # Dynamically import TaskConfigGenerator using importlib to avoid conflicts
        try:
            import importlib.util
            task_config_dir = Path(__file__).parent
            generate_task_config_path = task_config_dir / "generate_task_config.py"
            
            # Load module with a unique name to avoid conflicts with other environments
            spec = importlib.util.spec_from_file_location(
                "canvas_list_test_s2l.generate_task_config",
                generate_task_config_path
            )
            generate_task_config_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(generate_task_config_module)
            
            TaskConfigGenerator = generate_task_config_module.TaskConfigGenerator
        except ImportError as e:
            self.logger.warning(f"Could not import TaskConfigGenerator: {e}")
            self.logger.warning(f"Looked in: {task_config_dir}")
            self.logger.warning(
                "Please ensure generate_task_config.py is in the same directory "
                "as canvas_list_test_s2l.py"
            )
            return None
        
        self.logger.info("\nGenerating task configuration...")
        self.logger.info(f"  Output directory: {self.task_dir}")
        self.logger.info(f"  Num courses: {self.num_courses}")
        self.logger.info(f"  Num students: {self.num_students}")
        self.logger.info(f"  Quiz prob: {self.quiz_prob}")
        self.logger.info(f"  Assignment prob: {self.assignment_prob}")
        self.logger.info(f"  Submission prob: {self.submission_prob}")
        self.logger.info(f"  Exemption prob: {self.exemption_prob}")
        self.logger.info(f"  Exemption meet prob: {self.exemption_meet_prob}")
        self.logger.info(f"  Seed: {self.seed}")
        self.logger.info("=" * 60)
        
        # Create generator
        generator = TaskConfigGenerator(seed=self.seed)
        
        # Generate and save configuration
        try:
            stats = generator.save_config(
                output_dir=Path(self.task_dir),
                num_courses=self.num_courses,
                num_students=self.num_students,
                quiz_probability=self.quiz_prob,
                assignment_probability=self.assignment_prob,
                submission_probability=self.submission_prob,
                quiz_difficulty=self.quiz_difficulty,
                assignment_difficulty=self.assignment_difficulty,
                exemption_probability=self.exemption_prob,
                exemption_meet_probability=self.exemption_meet_prob,
                no_exam_probability=self.no_exam_prob
            )
            
            self.logger.info("\nConfiguration generation completed!")
            self.logger.info(f"  Generated {stats['courses']} courses")
            self.logger.info(f"  Total tasks: {stats['total_tasks']}")
            self.logger.info(f"  Groundtruth tasks: {stats['groundtruth_total']}")
            
            return stats
            
        except Exception as e:
            self.logger.error(f"Error generating configuration: {e}")
            self.logger.error(traceback.format_exc())
            return None

    def reset(self, seed: Optional[int] = None) -> Tuple[str, Dict[str, Any]]:
        """Reset environment and execute Canvas test environment preprocessing.
        
        Steps include:
        1. Generate task configuration
        2. Clear local database
        3. Create courses (including updating deadlines and CSV files)
        4. Submit student assignments
        5. Copy initial CSV templates to agent workspace
        
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
            self.config_file = Path(self.task_dir) / "files" / "course_config.json"
            self.users_file = Path(self.task_dir) / "files" / "canvas_users.json"
            self.courses_data = None
            self.users_data = None

            self.logger.info("Starting Canvas test environment preprocessing...")
            self.logger.info("=" * 60)
            
            # Step 0: Generate configuration
            self.logger.info("\nStep 0: Generate task configuration...")
            self.logger.info("=" * 60)
            config_stats = self.generate_config()
            if not config_stats:
                self.logger.error("Configuration generation failed, aborting preprocessing")
                return self._get_instructions(), {}
            
            # Import main_simplified module using absolute import to avoid conflicts
            try:
                import importlib.util
                import types
                env_dir = Path(__file__).parent
                main_simplified_path = env_dir / "main_simplified.py"
                
                # Create a fake parent package module for relative imports to work
                package_name = "canvas_list_test_s2l"
                if package_name not in sys.modules:
                    fake_package = types.ModuleType(package_name)
                    fake_package.__path__ = [str(env_dir)]
                    fake_package.__file__ = str(env_dir / "__init__.py")
                    sys.modules[package_name] = fake_package
                
                # Also load extract_quiz_info which is imported by main_simplified
                extract_quiz_info_path = env_dir / "extract_quiz_info.py"
                extract_spec = importlib.util.spec_from_file_location(
                    f"{package_name}.extract_quiz_info",
                    extract_quiz_info_path
                )
                extract_module = importlib.util.module_from_spec(extract_spec)
                sys.modules[f"{package_name}.extract_quiz_info"] = extract_module
                extract_spec.loader.exec_module(extract_module)
                
                # Load module with a unique name to avoid conflicts with other environments
                spec = importlib.util.spec_from_file_location(
                    f"{package_name}.main_simplified", 
                    main_simplified_path
                )
                main_simplified_module = importlib.util.module_from_spec(spec)
                sys.modules[f"{package_name}.main_simplified"] = main_simplified_module
                spec.loader.exec_module(main_simplified_module)
                
                run_with_args = main_simplified_module.run_with_args
            except ImportError as e:
                self.logger.warning(f"Could not import main_simplified: {e}")
                self.logger.warning(f"Looked in: {env_dir}")
                return self._get_instructions(), {}
            
            # Step 1: Clear local database
            self.logger.info("\nStep 1: Clear local database")
            self.logger.info("=" * 60)
            run_with_args(
                delete=True,
                agent_workspace=str(self.agent_workspace),
                task_dir=self.task_dir
            )
            
            # Step 2: Create courses (including updating deadlines and CSV files)
            self.logger.info("\nStep 2: Create courses (including deadlines and CSV)")
            self.logger.info("=" * 60)
            run_with_args(
                agent_workspace=str(self.agent_workspace),
                task_dir=self.task_dir
            )
            
            # Step 3: Submit student assignments based on submission_config.json
            self.logger.info("\nStep 3: Submit student assignments (based on submission_config.json)")
            self.logger.info("=" * 60)
            run_with_args(
                submit_assignments=True,
                agent_workspace=str(self.agent_workspace),
                task_dir=self.task_dir
            )
            
            # Reload database to get latest data
            self.logger.info("\nReloading database...")
            self.db = CanvasDatabase(data_dir=self.canvas_data_dir)
            self.logger.info("Database reloaded successfully")
            self.logger.info(f"  - Courses: {len(self.db.courses)}")
            self.logger.info(f"  - Users: {len(self.db.users)}")
            self.logger.info(f"  - Quizzes: {len(self.db.quizzes)}")
            self.logger.info(f"  - Assignments: {len(self.db.assignments)}")
            
            self.logger.info("\nCanvas test environment preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("Task configuration generated (including groundtruth CSV)")
            self.logger.info("Local database cleared and reinitialized")
            self.logger.info("All courses created and published")
            self.logger.info("Course deadlines updated to future dates")
            self.logger.info("Quiz and assignment CSV files updated")
            self.logger.info("Student assignments submitted per configuration")
            self.logger.info("Ryan Brown's memory.json generated")
            self.logger.info("\nUsing local JSON database, no Canvas API required")
            
            # Step 4: Copy initial CSV templates to agent workspace
            self._copy_csv_templates()
            
            return self._get_instructions(), {}
            
        except Exception as e:
            self.logger.error(f"Error during preprocessing: {e}")
            self.logger.error(traceback.format_exc())
            return self._get_instructions(), {}
    
    def _copy_csv_templates(self) -> None:
        """Copy initial CSV template files to agent workspace."""
        self.logger.info("\nStep 4: Copy initial CSV templates to agent workspace")
        self.logger.info("=" * 60)
        
        try:
            # Source file paths (template CSV files)
            template_dir = Path(__file__).parent / "initial_workspace"
            quiz_template = template_dir / QUIZ_INFO_CSV
            assignment_template = template_dir / ASSIGNMENT_INFO_CSV
            
            # Target directory (agent workspace)
            target_dir = self.agent_workspace
            target_dir.mkdir(parents=True, exist_ok=True)
            
            # Copy files
            if quiz_template.exists():
                shutil.copy2(quiz_template, target_dir / QUIZ_INFO_CSV)
                self.logger.info(f"  Copied {QUIZ_INFO_CSV} to {target_dir}")
            else:
                self.logger.warning(f"  Template file not found: {quiz_template}")
            
            if assignment_template.exists():
                shutil.copy2(assignment_template, target_dir / ASSIGNMENT_INFO_CSV)
                self.logger.info(f"  Copied {ASSIGNMENT_INFO_CSV} to {target_dir}")
            else:
                self.logger.warning(f"  Template file not found: {assignment_template}")
            
            self.logger.info("Initial CSV template files copied successfully")
            
        except Exception as e:
            self.logger.warning(f"Error copying CSV template files: {e}")
            self.logger.error(traceback.format_exc())

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
                "canvas_list_test_s2l.check_local",
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
            "  Column integrity: Passed\n"
            "  Row count: Passed\n"
            "  Order consistency: Passed\n"
            "  Content matching: Passed\n"
            "  Data types: Passed\n"
            "\nCongratulations! You have successfully completed all task requirements.\n"
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