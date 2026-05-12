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
TASK_INSTRUCTION = '''You need to read the inventory levels of WooCommerce products, check the current stock quantity (stock_quantity) for each product against the safety threshold (stock_threshold), identify all products with stock strictly below the threshold (stock_quantity < stock_threshold), and automatically update a Google Sheets purchase requisition list named WooCommerce Stock Alert (already in Google Sheets). For each low-stock product, record it in Google Sheets and send an individual email notification to the purchasing manager (the email address is in purchasing_manager_email.txt). You need to find all low-stock products, record them and send emails. The email template can be found in stock_alert_email_template.md. The email account credentials are in admin_credentials.txt in the workspace.'''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'


class WoocommerceStockAlertS2LEnv(Env):
    """WooCommerce Stock Alert S2L Environment for inventory monitoring.
    
    This environment simulates a WooCommerce scenario where the agent needs to:
    1. Monitor product inventory levels in WooCommerce
    2. Identify products with stock below safety threshold
    3. Update Google Sheets with low-stock products
    4. Send email alerts to purchasing manager
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        num_low_stock: int = 10,
        num_normal_stock: int = 100,
        seed: int = 42,
        difficulty: Optional[str] = None,
        verbose: bool = False,
        **_,
    ):
        """Initialize the WooCommerce Stock Alert S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            num_low_stock: Number of low-stock products (need alert) (default: 10)
            num_normal_stock: Number of normal-stock products (no alert) (default: 100)
            seed: Random seed for reproducibility (default: 42)
            difficulty: Difficulty preset (easy/medium/hard/expert/extreme/ultra/insane/nightmare/apocalypse/godlike)
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
        self.google_sheet_data_dir = self.data_dir / "google_sheets"

        # Clear task directory if it exists, then create it
        if Path(self.task_dir).exists():
            nfs_safe_rmtree(self.task_dir)
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        
        # Setup logging system
        self._setup_logging()

        # Configuration generation parameters
        self.num_low_stock = num_low_stock
        self.num_normal_stock = num_normal_stock
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
        self.logger = logging.getLogger(f"WoocommerceStockAlertS2L_{id(self)}")
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
        """Reset environment and execute WooCommerce Stock Alert preprocessing.
        
        Steps include:
        1. Generate product data with configurable difficulty
        2. Initialize WooCommerce, Email, and Google Sheets databases
        3. Clear email folders
        4. Sync products to WooCommerce
        5. Initialize Google Sheets with stock alert template
        6. Copy initial workspace files to agent workspace
        
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

            self.logger.info("Starting WooCommerce Stock Alert preprocessing...")
            self.logger.info("=" * 60)
            
            # Import preprocessing module using importlib to avoid conflicts
            try:
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
            
            # Call the preprocessing as a subprocess
            try:
                import subprocess
                
                # Create temporary task root for preprocessing
                temp_task_root = Path(self.task_dir) / "temp_preprocess"
                temp_task_root.mkdir(parents=True, exist_ok=True)
                
                # Copy necessary files to temp task root (only config files need to be there)
                source_files = [
                    "emails_config.json",
                    "task_config.json"
                ]

                for file_name in source_files:
                    source_file = env_dir / file_name
                    if source_file.exists():
                        dest_file = temp_task_root / file_name
                        shutil.copy2(source_file, dest_file)
                        self.logger.info(f"  Copied {file_name} to temp task root")

                # Copy initial_workspace directory if it exists
                initial_workspace_dir = env_dir / "initial_workspace"
                if initial_workspace_dir.exists():
                    dest_dir = temp_task_root / "initial_workspace"
                    shutil.copytree(initial_workspace_dir, dest_dir, dirs_exist_ok=True)
                    self.logger.info(f"  Copied initial_workspace/ to temp task root")

                # Set up environment variables for database directories
                import os
                env = os.environ.copy()
                env['WOOCOMMERCE_DATA_DIR'] = str(self.woocommerce_data_dir)
                env['EMAIL_DATA_DIR'] = str(self.email_data_dir)
                env['GOOGLE_SHEET_DATA_DIR'] = str(self.google_sheet_data_dir)

                # Use preprocess/main.py directly from env_dir
                env_preprocess_main = env_dir / "preprocess" / "main.py"

                cmd = [
                    sys.executable,
                    str(env_preprocess_main),
                    "--agent_workspace", str(self.agent_workspace),
                    "--task_root", str(self.task_dir),
                    "--num-low-stock", str(self.num_low_stock),
                    "--num-normal-stock", str(self.num_normal_stock),
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
            
            self.logger.info("\nWooCommerce Stock Alert preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("Product data generated")
            self.logger.info("WooCommerce, Email, and Google Sheets databases initialized")
            self.logger.info("Products synced to WooCommerce")
            self.logger.info("Google Sheets initialized with template")
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
            
            # Check if preprocess directory has generated files (now in task_dir)
            task_preprocess = Path(self.task_dir) / "preprocess"
            if task_preprocess.exists():
                self.logger.info(f"  Found preprocess directory with generated files")

                # List generated files for logging
                generated_files = [
                    "woocommerce_products.json"
                ]

                for file_name in generated_files:
                    file_path = task_preprocess / file_name
                    if file_path.exists():
                        self.logger.info(f"  Found generated {file_name} in preprocess/")
            
            # Move files directory (sheet_id.txt, etc.)
            temp_files = temp_task_root / "files"
            if temp_files.exists():
                dest_files = Path(self.task_dir) / "files"
                if dest_files.exists():
                    nfs_safe_rmtree(dest_files)
                shutil.move(str(temp_files), str(dest_files))
                self.logger.info(f"  Moved files/ to {dest_files}")
            
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
        """Execute environment step and check agent's stock alert system implementation.
        
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
            
            self.logger.info("\nValidating stock alert system implementation...")
            
            # Run evaluation via subprocess to avoid module conflicts
            try:
                import subprocess
                import os

                # Check evaluation directory
                eval_source_dir = env_dir / "evaluation"

                if not eval_source_dir.exists():
                    error_msg = f"Evaluation directory not found at {eval_source_dir}"
                    self.logger.error(error_msg)
                    return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}

                # Set up environment
                env = os.environ.copy()
                env['WOOCOMMERCE_DATA_DIR'] = str(self.woocommerce_data_dir)
                env['EMAIL_DATA_DIR'] = str(self.email_data_dir)
                env['GOOGLE_SHEET_DATA_DIR'] = str(self.google_sheet_data_dir)

                cmd = [
                    sys.executable,
                    str(eval_source_dir / "main.py"),
                    "--agent_workspace", str(self.agent_workspace)
                ]

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd=str(eval_source_dir),
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
                    error_msg = "Stock alert system validation failed. Check the evaluation output above."
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
            "  ✓ All low-stock products correctly identified (stock < threshold)\n"
            "  ✓ Google Sheets updated with all low-stock products\n"
            "  ✓ Sheet data accurate (SKU, stock levels, supplier info)\n"
            "  ✓ Email alerts sent to purchasing manager for each low-stock product\n"
            "  ✓ Email content follows template format\n"
            "  ✓ No normal-stock products incorrectly flagged\n"
            "\nCongratulations! You have successfully completed the stock alert monitoring task.\n"
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
            "  - Did you query WooCommerce for all products?\n"
            "  - Did you correctly identify products where stock_quantity < stock_threshold?\n"
            "  - Did you add ALL low-stock products to the Google Sheet?\n"
            "  - Did you avoid adding normal-stock products to the sheet?\n"
            "  - Did you send email alerts to laura_thompson@mcp.com?\n"
            "  - Did you send one email per low-stock product?\n"
            "  - Did you follow the email template format?\n"
            "  - Did you include product details (SKU, stock, supplier) in emails?\n"
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

