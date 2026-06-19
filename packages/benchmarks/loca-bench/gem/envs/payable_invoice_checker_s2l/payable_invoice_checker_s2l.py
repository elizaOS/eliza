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
TASK_INSTRUCTION = '''Help me automatically update the two existing tables in the PURCHASE_INVOICE database with all the received receipts in my workspace(without damaging the existing data in the database). For receipts that are not fully paid (including receipts whose payment is still in progress), send an email to the relevant purchasing manager with the subject "Process Outstanding Invoices". The email body should include all the filenames that the manager still needs to process. Also, set a column description for outstanding_flag precisely as: "0=Paid, 1=Outstanding".'''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'


class PayableInvoiceCheckerS2LEnv(Env):
    """Payable Invoice Checker S2L Environment for invoice processing.
    
    This environment simulates a financial scenario where the agent needs to:
    1. Extract invoice data from PDF files in the workspace
    2. Update Snowflake database tables (INVOICES and INVOICE_PAYMENTS)
    3. Send email notifications to purchasing managers for unpaid invoices
    4. Set proper column descriptions in the database
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        num_invoices: int = 30,
        num_interference: int = 1000,
        seed: int = 42,
        difficulty: Optional[str] = None,
        verbose: bool = False,
        **_,
    ):
        """Initialize the Payable Invoice Checker S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            num_invoices: Number of invoice PDFs to generate (default: 30)
            num_interference: Number of interference records in database (default: 1000)
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
        self.snowflake_data_dir = self.data_dir / "snowflake"
        self.email_data_dir = self.data_dir / "emails"

        # Clear task directory if it exists, then create it
        if Path(self.task_dir).exists():
            nfs_safe_rmtree(self.task_dir)
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        
        # Setup logging system
        self._setup_logging()

        # Configuration generation parameters
        self.num_invoices = num_invoices
        self.num_interference = num_interference
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
        self.logger = logging.getLogger(f"PayableInvoiceCheckerS2L_{id(self)}")
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
        """Reset environment and execute Payable Invoice Checker preprocessing.
        
        Steps include:
        1. Generate invoice PDF files
        2. Initialize Snowflake database with interference data
        3. Initialize Email database
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

            self.logger.info("Starting Payable Invoice Checker preprocessing...")
            self.logger.info("=" * 60)
            
            # Import preprocessing module using importlib to avoid conflicts
            try:
                import importlib.util
                env_dir = Path(__file__).parent
                preprocess_main_path = env_dir / "preprocess" / "main.py"
                
                # Check if preprocess directory exists
                if not preprocess_main_path.exists():
                    error_msg = f"Preprocess module not found at {preprocess_main_path}"
                    self.logger.error(error_msg)
                    return self._get_instructions(), {}
                
            except ImportError as e:
                self.logger.warning(f"Could not import preprocessing module: {e}")
                self.logger.warning(f"Looked in: {env_dir}")
                return self._get_instructions(), {}
            
            # Run preprocessing
            self.logger.info("\nRunning preprocessing pipeline...")
            self.logger.info("=" * 60)
            
            # Call the preprocessing as a subprocess directly from env_dir
            try:
                import subprocess
                import os
                
                # Set up environment variables for database directories
                env = os.environ.copy()
                env['SNOWFLAKE_DATA_DIR'] = str(self.snowflake_data_dir)
                env['EMAIL_DATA_DIR'] = str(self.email_data_dir)
                
                # Execute preprocess/main.py directly from env_dir as a module
                # Use -m to run as module, which handles relative imports correctly
                cmd = [
                    sys.executable,
                    "-m", "gem.envs.payable_invoice_checker_s2l.preprocess.main",
                    "--agent_workspace", str(self.agent_workspace),
                    "--num-invoices", str(self.num_invoices),
                    "--num-interference", str(self.num_interference),
                    "--seed", str(self.seed),
                ]
                
                # Add difficulty preset if specified
                if self.difficulty:
                    cmd.extend(["--difficulty", self.difficulty])
                
                # Run from gem root directory
                gem_root = env_dir.parent.parent.parent
                
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd=str(gem_root),
                    env=env
                )
                
                if result.stdout:
                    self.logger.info(result.stdout)
                
                if result.returncode != 0:
                    self.logger.error("Preprocessing failed")
                    if result.stderr:
                        self.logger.error(result.stderr)
                    return self._get_instructions(), {}
                
                # Organize generated files (they're created directly in task_dir)
                self._organize_generated_files_simple()
                
            except Exception as e:
                self.logger.error(f"Error running preprocessing: {e}")
                self.logger.error(traceback.format_exc())
                return self._get_instructions(), {}
            
            self.logger.info("\nPayable Invoice Checker preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("Invoice PDF files generated")
            self.logger.info("Snowflake database initialized with interference data")
            self.logger.info("Email database initialized")
            self.logger.info("Groundtruth generated")
            self.logger.info("Agent workspace ready")
            
            return self._get_instructions(), {}
            
        except Exception as e:
            self.logger.error(f"Error during preprocessing: {e}")
            self.logger.error(traceback.format_exc())
            return self._get_instructions(), {}
    
    def _organize_generated_files_simple(self) -> None:
        """Organize generated files that were created directly in task_dir.
        
        Since preprocessing now runs directly from code directory, files are
        generated in their proper locations. We just need to copy initial_workspace
        to agent_workspace.
        """
        self.logger.info("\nOrganizing generated files...")
        self.logger.info("=" * 60)
        
        try:
            # Copy initial_workspace to agent_workspace
            initial_workspace = Path(self.task_dir) / "initial_workspace"
            if initial_workspace.exists():
                # Create agent_workspace if it doesn't exist
                if self.agent_workspace.exists():
                    nfs_safe_rmtree(str(self.agent_workspace))
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
            
            # Copy files directory to agent_workspace/files
            files_dir = Path(self.task_dir) / "files"
            if files_dir.exists():
                dest_agent_files = self.agent_workspace / "files"
                if dest_agent_files.exists():
                    nfs_safe_rmtree(str(dest_agent_files))
                shutil.copytree(files_dir, dest_agent_files)
                self.logger.info(f"  Copied files/ to agent_workspace/files")
            
            self.logger.info("Files organized successfully")
            
        except Exception as e:
            self.logger.warning(f"Error organizing files: {e}")
            self.logger.error(traceback.format_exc())

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        """Execute environment step and check agent's invoice processing results.
        
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
            
            self.logger.info("\nValidating invoice processing and email notifications...")
            
            # Validate groundtruth workspace existence
            if not groundtruth_workspace.exists():
                error_msg = f"Missing groundtruth workspace: {groundtruth_workspace}"
                self.logger.error(error_msg)
                return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}
            
            # Run evaluation via subprocess directly from code directory
            try:
                import subprocess
                import os
                
                # Set up environment
                env = os.environ.copy()
                env['SNOWFLAKE_DATA_DIR'] = str(self.snowflake_data_dir)
                env['EMAIL_DATA_DIR'] = str(self.email_data_dir)
                
                # Execute evaluation/main.py directly as a module
                cmd = [
                    sys.executable,
                    "-m", "gem.envs.payable_invoice_checker_s2l.evaluation.main",
                    "--agent_workspace", str(self.agent_workspace),
                    "--groundtruth_workspace", str(groundtruth_workspace)
                ]
                
                # Run from gem root directory
                gem_root = env_dir.parent.parent.parent
                
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd=str(gem_root),
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
                    error_msg = "Invoice processing validation failed. Check the evaluation output above."
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
            "  ✓ All invoice data correctly inserted into Snowflake INVOICES table\n"
            "  ✓ All payment data correctly inserted into INVOICE_PAYMENTS table\n"
            "  ✓ All groundtruth payment statuses are correct\n"
            "  ✓ Interference data preserved (no damage to existing records)\n"
            "  ✓ Column description for OUTSTANDING_FLAG set correctly\n"
            "  ✓ Email notifications sent to correct purchasing managers\n"
            "  ✓ Email content includes all unpaid invoice filenames\n"
            "  ✓ No extra emails sent to paid buyers\n"
            "\nCongratulations! You have successfully completed the payable invoice checker task.\n"
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
            "  - Did you extract invoice data from all PDF files?\n"
            "  - Did you insert invoice data into PURCHASE_INVOICE.PUBLIC.INVOICES table?\n"
            "  - Did you insert payment data into PURCHASE_INVOICE.PUBLIC.INVOICE_PAYMENTS table?\n"
            "  - Did you preserve existing interference data in the database?\n"
            "  - Did you set OUTSTANDING_FLAG column description as '0=Paid, 1=Outstanding'?\n"
            "  - Did you identify buyers with unpaid invoices correctly?\n"
            "  - Did you send emails ONLY to buyers with unpaid invoices?\n"
            "  - Did you include all unpaid invoice filenames in each email?\n"
            "  - Did you use the correct email subject 'Process Outstanding Invoices'?\n"
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




