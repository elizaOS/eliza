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
TASK_INSTRUCTION = '''Please check my inbox, find all replies to PhD Applications, and for those that require submission of application materials, help me submit the relevant materials according to the request. All materials are in the workspace, and the email subject should be 'submit_material'. My personal information is in the memory.'''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'


class ApplyPhDEmailS2LEnv(Env):
    """Apply PhD Email S2L Environment for PhD application material organization.
    
    This environment simulates a PhD application scenario where the agent needs to
    process an email with instructions, organize application materials, and submit
    them via email with proper folder structure and file processing.
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        num_professors: int = 10,
        structure: str = "standard",
        receiver_idx: int = 0,
        seed: int = 42,
        num_positive: int = 1,
        positive_weight: float = 1.0,
        research_assistant_weight: float = 1.0,
        no_spots_weight: float = 1.0,
        no_response_weight: float = 1.0,
        assign_different_structures: bool = True,
        verbose: bool = False,
        **_,
    ):
        """Initialize the Apply PhD Email S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            num_professors: Number of professors to generate (default: 10)
            structure: File structure type (default: "standard")
            receiver_idx: Receiver index (default: 0)
            seed: Random seed for reproducibility
            num_positive: Number of positive responses (default: 1)
            positive_weight: Weight for positive responses (default: 1.0)
            research_assistant_weight: Weight for research assistant responses (default: 1.0)
            no_spots_weight: Weight for no spots responses (default: 1.0)
            no_response_weight: Weight for no response (default: 1.0)
            assign_different_structures: Assign different structures to professors (default: True)
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
        self.num_professors = num_professors
        self.structure = structure
        self.receiver_idx = receiver_idx
        self.seed = seed
        self.num_positive = num_positive
        self.positive_weight = positive_weight
        self.research_assistant_weight = research_assistant_weight
        self.no_spots_weight = no_spots_weight
        self.no_response_weight = no_response_weight
        self.assign_different_structures = assign_different_structures

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
        self.logger = logging.getLogger(f"ApplyPhDEmailS2L_{id(self)}")
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
        """Reset environment and execute Apply PhD Email preprocessing.
        
        Steps include:
        1. Generate task configuration (professors, emails, file structures)
        2. Initialize email database
        3. Import emails to database
        4. Copy initial workspace files (compressed materials) to agent workspace
        5. Generate groundtruth for evaluation
        
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

            self.logger.info("Starting Apply PhD Email preprocessing...")
            self.logger.info("=" * 60)
            
            # Import preprocessing module using importlib to avoid conflicts
            try:
                import importlib.util
                env_dir = Path(__file__).parent
                preprocess_main_path = env_dir / "preprocess" / "main.py"
                
                # Load module with a unique name to avoid conflicts with other environments
                spec = importlib.util.spec_from_file_location(
                    f"apply_phd_email_s2l_{id(self)}.preprocess_main",
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
                
                # Copy necessary files to temp task root
                source_files = [
                    "generate_task_config.py",
                    "email_config.json"
                ]
                
                for file_name in source_files:
                    source_file = env_dir / file_name
                    if source_file.exists():
                        dest_file = temp_task_root / file_name
                        shutil.copy2(source_file, dest_file)
                        self.logger.info(f"  Copied {file_name} to temp task root")
                
                # Copy initial_workspace and groundtruth_workspace directories
                # Note: preprocess directory is NOT copied, we run main.py from original location
                for dir_name in ["initial_workspace", "groundtruth_workspace"]:
                    source_dir = env_dir / dir_name
                    if source_dir.exists():
                        dest_dir = temp_task_root / dir_name
                        shutil.copytree(source_dir, dest_dir, dirs_exist_ok=True)
                        self.logger.info(f"  Copied {dir_name} to temp task root")
                
                # Copy initial workspace to agent workspace BEFORE preprocessing
                # (preprocessing script needs files.tar.gz in agent_workspace)
                self.logger.info("\nCopying initial workspace to agent workspace (before preprocessing)...")
                initial_workspace_dir = env_dir / "initial_workspace"
                if initial_workspace_dir.exists():
                    self.agent_workspace.mkdir(parents=True, exist_ok=True)
                    for item in initial_workspace_dir.iterdir():
                        if item.is_file():
                            shutil.copy2(item, self.agent_workspace / item.name)
                            self.logger.info(f"  Copied {item.name} to agent workspace")
                        elif item.is_dir():
                            shutil.copytree(item, self.agent_workspace / item.name, dirs_exist_ok=True)
                            self.logger.info(f"  Copied directory {item.name} to agent workspace")
                
                # Set up environment variable for email data directory
                import os
                env = os.environ.copy()
                env['EMAIL_DATA_DIR'] = str(self.email_data_dir)

                # Use preprocess/main.py from original env_dir (not copied)
                # Pass --task-root to specify where generated files are located
                preprocess_main = env_dir / "preprocess" / "main.py"

                cmd = [
                    sys.executable,
                    str(preprocess_main),
                    "--agent_workspace", str(self.agent_workspace),
                    "--num-professors", str(self.num_professors),
                    "--structure", self.structure,
                    "--receiver-idx", str(self.receiver_idx),
                    "--seed", str(self.seed),
                    "--num-positive", str(self.num_positive),
                    "--positive-weight", str(self.positive_weight),
                    "--research-assistant-weight", str(self.research_assistant_weight),
                    "--no-spots-weight", str(self.no_spots_weight),
                    "--no-response-weight", str(self.no_response_weight),
                    "--task-root", str(temp_task_root),
                ]

                # Only add flag if we want to DISABLE assign_different_structures
                # Default is True (enabled), so we only pass flag when False
                if not self.assign_different_structures:
                    cmd.append("--no-assign-different-structures")

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
            
            self.logger.info("\nApply PhD Email preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("Task configuration generated")
            self.logger.info("Email database initialized and populated")
            self.logger.info("Groundtruth generated")
            self.logger.info("Agent workspace ready")
            
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
            # Get environment directory (code directory)
            env_dir = Path(__file__).parent
            
            # Move files directory from both possible locations
            temp_files = temp_task_root / "files"
            env_files = env_dir / "files"
            dest_files = Path(self.task_dir) / "files"
            
            if temp_files.exists():
                if dest_files.exists():
                    nfs_safe_rmtree(dest_files)
                shutil.move(str(temp_files), str(dest_files))
                self.logger.info(f"  Moved files/ from temp to {dest_files}")
            elif env_files.exists():
                if dest_files.exists():
                    nfs_safe_rmtree(dest_files)
                shutil.move(str(env_files), str(dest_files))
                self.logger.info(f"  Moved files/ from env_dir to {dest_files}")
            
            # Move initial_workspace directory (if updated by preprocessing)
            temp_initial = temp_task_root / "initial_workspace"
            if temp_initial.exists():
                dest_initial = Path(self.task_dir) / "initial_workspace"
                if dest_initial.exists():
                    nfs_safe_rmtree(dest_initial)
                shutil.move(str(temp_initial), str(dest_initial))
                self.logger.info(f"  Moved initial_workspace/ to {dest_initial}")
            
            # Move groundtruth_workspace directory (if updated by preprocessing)
            temp_groundtruth = temp_task_root / "groundtruth_workspace"
            if temp_groundtruth.exists():
                dest_groundtruth = Path(self.task_dir) / "groundtruth_workspace"
                if dest_groundtruth.exists():
                    nfs_safe_rmtree(dest_groundtruth)
                shutil.move(str(temp_groundtruth), str(dest_groundtruth))
                self.logger.info(f"  Moved groundtruth_workspace/ to {dest_groundtruth}")
            
            # Move task_config_generated.json from both possible locations
            temp_config = temp_task_root / "task_config_generated.json"
            env_config = env_dir / "task_config_generated.json"
            dest_config = Path(self.task_dir) / "task_config_generated.json"
            
            if temp_config.exists():
                shutil.move(str(temp_config), str(dest_config))
                self.logger.info(f"  Moved task_config_generated.json from temp to {dest_config}")
            elif env_config.exists():
                shutil.move(str(env_config), str(dest_config))
                self.logger.info(f"  Moved task_config_generated.json from env_dir to {dest_config}")
            
            # Copy email_config.json from env_dir to task_dir (needed for evaluation)
            env_email_config = env_dir / "email_config.json"
            dest_email_config = Path(self.task_dir) / "email_config.json"
            
            if env_email_config.exists():
                shutil.copy2(str(env_email_config), str(dest_email_config))
                self.logger.info(f"  Copied email_config.json to {dest_email_config}")
            
            self.logger.info("Files organized successfully")
            
        except Exception as e:
            self.logger.warning(f"Error organizing files: {e}")
            self.logger.error(traceback.format_exc())
    
    def _copy_initial_workspace(self) -> None:
        """Copy initial workspace files to agent workspace.
        
        This method copies files from initial_workspace (in task_dir) to the agent's
        working directory, making them available for the agent to process.
        """
        self.logger.info("\nCopying initial workspace to agent workspace...")
        self.logger.info("=" * 60)
        
        try:
            # Source directory (initial workspace in task_dir)
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
        """Execute environment step and check agent's email submission results.
        
        Args:
            action: Agent's action (typically triggered by claim_done tool)
        
        Returns:
            Tuple[str, float, bool, bool, Dict[str, Any]]: 
                (observation, reward, terminated, truncated, info)
        """
        super().step(action)
        
        env_dir = Path(__file__).parent
        
        self.logger.info("\n" + "=" * 80)
        self.logger.info("Starting task evaluation")
        self.logger.info("=" * 80)
        
        # Execute evaluation
        try:
            # Import EmailDatabase
            from mcp_convert.mcps.email.database_utils import EmailDatabase

            # Initialize Email database
            self.logger.info("\nInitializing Email Database for evaluation...")
            email_db_dir = str(self.email_data_dir)
            self.logger.info(f"Using Email Database Directory: {email_db_dir}")
            
            if not Path(email_db_dir).exists():
                error_msg = f"Email database directory not found: {email_db_dir}"
                self.logger.error(error_msg)
                return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}
            
            email_db = EmailDatabase(data_dir=email_db_dir)
            
            # Define paths
            groundtruth_workspace = Path(self.task_dir) / "groundtruth_workspace"
            task_config_file = Path(self.task_dir) / "task_config_generated.json"
            
            self.logger.info("\nValidating email submission...")
            
            # Validate groundtruth workspace existence
            if not groundtruth_workspace.exists():
                error_msg = f"Missing groundtruth workspace: {groundtruth_workspace}"
                self.logger.error(error_msg)
                return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}
            
            # Run evaluation via subprocess to avoid module conflicts
            try:
                import subprocess

                # Set up environment
                import os
                env = os.environ.copy()
                env['EMAIL_DATA_DIR'] = str(self.email_data_dir)

                # Use evaluation/main.py from original env_dir (not copied)
                # Pass --task-root to specify where task files are located
                eval_main = env_dir / "evaluation" / "main.py"

                cmd = [
                    sys.executable,
                    str(eval_main),
                    "--agent_workspace", str(self.agent_workspace),
                    "--groundtruth_workspace", str(groundtruth_workspace),
                    "--subject", "submit_material",
                    "--task-root", str(self.task_dir),
                ]

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    env=env
                )

                if result.stdout:
                    self.logger.info(result.stdout)

                # Check if evaluation succeeded
                evaluation_passed = (result.returncode == 0)
                
                if evaluation_passed:
                    observation = self._create_success_observation()
                    reward = 1.0
                    info = {
                        "success": True,
                        "error": None,
                        "evaluation": "passed"
                    }
                else:
                    error_msg = "Email submission validation failed. Check the evaluation output above."
                    if result.stderr:
                        error_msg += f"\n{result.stderr}"
                    observation = self._create_failure_observation(error_msg)
                    reward = 0.0
                    info = {
                        "success": False,
                        "error": error_msg,
                        "evaluation": "failed"
                    }
                
            except Exception as e:
                error_msg = f"Evaluation subprocess error: {str(e)}"
                self.logger.error(error_msg)
                self.logger.error(traceback.format_exc())
                
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
            "  ✓ Email sent to correct recipient with subject 'submit_material'\n"
            "  ✓ ZIP attachment contains correct folder structure\n"
            "  ✓ All required files are present and properly named\n"
            "  ✓ Award certificates merged chronologically in correct order\n"
            "  ✓ Recommendation letters renamed with actual professor names\n"
            "  ✓ Personal information correctly used in folder naming\n"
            "\nCongratulations! You have successfully completed the PhD application email task.\n"
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
            "  - Did you read the email from kaiming to understand requirements?\n"
            "  - Did you organize files according to the specified folder structure?\n"
            "  - Did you rename CV.pdf to Resume.pdf?\n"
            "  - Did you read recommendation letter PDFs and rename them with professor names?\n"
            "  - Did you merge award certificates chronologically?\n"
            "  - Did you retrieve personal information from memory?\n"
            "  - Did you send the email to the correct recipient with correct subject?\n"
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

