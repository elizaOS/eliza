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
TASK_INSTRUCTION = '''Please check all customers who have only completed one order in our store within the past 7 days and immediately sync their information (name, email address, etc.) from WooCommerce to our core customer relationship database (Table customers in woocommerce_crm dataset in BigQuery). At the same time, send a welcome email to each customer. Please follow the email format in the template (welcome_email_template.md). The email account credentials are in admin_credentials.txt in the workspace.'''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'


class WoocommerceNewWelcomeS2LEnv(Env):
    """WooCommerce New Welcome S2L Environment for new customer onboarding.
    
    This environment simulates a WooCommerce scenario where the agent needs to:
    1. Identify new customers who placed their first order in the past 7 days
    2. Sync them to the company CRM (BigQuery)
    3. Send welcome emails to new customers
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        total_orders: int = 20,
        first_time_customers: int = 10,
        noise_outside_window: int = 0,
        noise_incomplete: int = 0,
        seed: int = 42,
        difficulty: Optional[str] = None,
        verbose: bool = False,
        **_,
    ):
        """Initialize the WooCommerce New Welcome S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            total_orders: Total number of orders to generate (default: 20)
            first_time_customers: Number of first-time customers (default: 10)
            noise_outside_window: Number of noise orders outside 7-day window (default: 0)
            noise_incomplete: Number of incomplete noise orders (default: 0)
            seed: Random seed for reproducibility (default: 42)
            difficulty: Difficulty preset (easy/medium/hard/expert/extreme)
            verbose: Whether to output to console
        """
        super().__init__()
        self.task_dir = task_dir
        self.verbose = verbose

        # Setup directory paths
        self.agent_workspace = Path(self.task_dir) / "agent_workspace"
        self.data_dir = Path(self.task_dir) / "local_db"
        self.woocommerce_data_dir = self.data_dir / "woocommerce"
        self.email_data_dir = self.data_dir / "emails"
        self.gcloud_data_dir = self.data_dir / "google_cloud"

        # Clear task directory if it exists, then create it
        if Path(self.task_dir).exists():
            nfs_safe_rmtree(self.task_dir)
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        
        # Setup logging system
        self._setup_logging()

        # Configuration generation parameters
        self.total_orders = total_orders
        self.first_time_customers = first_time_customers
        self.noise_outside_window = noise_outside_window
        self.noise_incomplete = noise_incomplete
        self.seed = seed
        self.difficulty = difficulty

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
        self.logger = logging.getLogger(f"WoocommerceNewWelcomeS2L_{id(self)}")
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
        """Reset environment and execute WooCommerce New Welcome preprocessing.
        
        Steps include:
        1. Generate WooCommerce order and customer data
        2. Initialize WooCommerce, Email, and BigQuery databases
        3. Populate databases with generated data
        4. Copy initial workspace files to agent workspace
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

            self.logger.info("Starting WooCommerce New Welcome preprocessing...")
            self.logger.info("=" * 60)
            
            # Verify preprocessing module exists
            env_dir = Path(__file__).parent
            preprocess_main_path = env_dir / "preprocess" / "main.py"

            if not preprocess_main_path.exists():
                error_msg = f"Preprocess module not found at {preprocess_main_path}"
                self.logger.error(error_msg)
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
                    "emails_config.json"
                ]

                for file_name in source_files:
                    source_file = env_dir / file_name
                    if source_file.exists():
                        dest_file = temp_task_root / file_name
                        shutil.copy2(source_file, dest_file)
                        self.logger.info(f"  Copied {file_name} to temp task root")

                # Copy initial_workspace directory to task_dir (NOT temp_task_root)
                # This is where main.py expects it: task_root = Path(agent_workspace).parent = self.task_dir
                source_dir = env_dir / "initial_workspace"
                if source_dir.exists():
                    dest_dir = Path(self.task_dir) / "initial_workspace"
                    shutil.copytree(source_dir, dest_dir, dirs_exist_ok=True)
                    self.logger.info(f"  Copied initial_workspace/ to task_dir")
                
                # Set up environment variables for database directories
                import os
                env = os.environ.copy()
                env['WOOCOMMERCE_DATA_DIR'] = str(self.woocommerce_data_dir)
                env['EMAIL_DATA_DIR'] = str(self.email_data_dir)
                env['GOOGLE_CLOUD_DATA_DIR'] = str(self.gcloud_data_dir)

                # Use preprocess/main.py from original location (don't copy code)
                preprocess_main = env_dir / "preprocess" / "main.py"

                cmd = [
                    sys.executable,
                    str(preprocess_main),
                    "--agent_workspace", str(self.agent_workspace),
                    "--total-orders", str(self.total_orders),
                    "--first-time-customers", str(self.first_time_customers),
                    "--noise-outside-window", str(self.noise_outside_window),
                    "--noise-incomplete", str(self.noise_incomplete),
                    "--seed", str(self.seed),
                ]
                
                # Add difficulty preset if specified
                if self.difficulty:
                    cmd.extend(["--difficulty", self.difficulty])
                
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
            
            self.logger.info("\nWooCommerce New Welcome preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("WooCommerce orders and customer data generated")
            self.logger.info("Email and BigQuery databases initialized and populated")
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

            # Move initial_workspace directory (if updated by preprocessing)
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

            # Copy emails_config.json from env_dir to task_dir (if it exists)
            env_emails_config = env_dir / "emails_config.json"
            dest_emails_config = Path(self.task_dir) / "emails_config.json"

            if env_emails_config.exists():
                shutil.copy2(str(env_emails_config), str(dest_emails_config))
                self.logger.info(f"  Copied emails_config.json to {dest_emails_config}")

            # Copy initial_workspace to agent_workspace
            initial_workspace = Path(self.task_dir) / "initial_workspace"
            if initial_workspace.exists():
                # Create agent_workspace if it doesn't exist
                if self.agent_workspace.exists():
                    nfs_safe_rmtree(self.agent_workspace)
                self.agent_workspace.mkdir(parents=True, exist_ok=True)

                # Copy all files from initial_workspace to agent_workspace
                for item in initial_workspace.iterdir():
                    if item.is_file():
                        shutil.copy2(item, self.agent_workspace / item.name)
                        self.logger.info(f"  Copied {item.name} to agent_workspace")
                    elif item.is_dir():
                        shutil.copytree(item, self.agent_workspace / item.name)
                        self.logger.info(f"  Copied {item.name}/ to agent_workspace")

                self.logger.info(f"  Copied initial_workspace contents to {self.agent_workspace}")

            self.logger.info("Files organized successfully")

        except Exception as e:
            self.logger.warning(f"Error organizing files: {e}")
            self.logger.error(traceback.format_exc())

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        """Execute environment step and check agent's customer sync and email results.
        
        Args:
            action: Agent's action (typically triggered by claim_done tool)
        
        Returns:
            Tuple[str, float, bool, bool, Dict[str, Any]]: 
                (observation, reward, terminated, truncated, info)
        """
        super().step(action)
        
        self.logger.info("\n" + "=" * 80)
        self.logger.info("Starting task evaluation")
        self.logger.info("=" * 80)
        
        # Execute evaluation
        try:
            # Define paths
            env_dir = Path(__file__).parent
            groundtruth_workspace = Path(self.task_dir) / "groundtruth_workspace"
            
            self.logger.info("\nValidating customer sync and welcome emails...")
            
            # Check if groundtruth workspace exists (optional for this task)
            if not groundtruth_workspace.exists():
                self.logger.warning(f"Groundtruth workspace not found: {groundtruth_workspace}")
                self.logger.info("Proceeding with evaluation without groundtruth metadata")
                groundtruth_workspace = None
            
            # Run evaluation via subprocess to avoid module conflicts
            try:
                import subprocess
                import os

                # Verify evaluation directory exists
                eval_dir = env_dir / "evaluation"
                if not eval_dir.exists():
                    error_msg = f"Evaluation directory not found at {eval_dir}"
                    self.logger.error(error_msg)
                    return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}

                # Set up environment
                env = os.environ.copy()
                env['WOOCOMMERCE_DATA_DIR'] = str(self.woocommerce_data_dir)
                env['EMAIL_DATA_DIR'] = str(self.email_data_dir)
                env['GOOGLE_CLOUD_DATA_DIR'] = str(self.gcloud_data_dir)

                # Use evaluation/main.py from original location (don't copy code)
                eval_main = eval_dir / "main.py"

                cmd = [
                    sys.executable,
                    str(eval_main),
                    "--agent_workspace", str(self.agent_workspace)
                ]

                # Add groundtruth_workspace if it exists
                if groundtruth_workspace is not None:
                    cmd.extend(["--groundtruth_workspace", str(groundtruth_workspace)])

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd=str(eval_dir),
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
                    error_msg = "Customer sync and email validation failed. Check the evaluation output above."
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
            "  ✓ All first-time customers correctly identified (first order within 7 days)\n"
            "  ✓ Customers successfully synced to BigQuery CRM database\n"
            "  ✓ Welcome emails sent to all first-time customers\n"
            "  ✓ Email content follows template and includes order details\n"
            "  ✓ No historical customers or noise data incorrectly processed\n"
            "\nCongratulations! You have successfully completed the new customer welcome task.\n"
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
            "  - Did you query WooCommerce for orders in the past 7 days?\n"
            "  - Did you correctly identify first-time customers (only 1 completed order)?\n"
            "  - Did you filter out orders outside the 7-day window?\n"
            "  - Did you filter out incomplete orders (processing/on-hold status)?\n"
            "  - Did you sync ONLY first-time customers to BigQuery?\n"
            "  - Did you mark welcome_email_sent=true in BigQuery?\n"
            "  - Did you send welcome emails to all first-time customers?\n"
            "  - Did you use the provided email template?\n"
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

