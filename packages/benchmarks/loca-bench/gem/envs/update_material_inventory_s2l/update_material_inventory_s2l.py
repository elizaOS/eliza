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
TASK_INSTRUCTION = '''Please help me monitor new paid orders in WooCommerce, retrieve the SKU and quantity of each finished product in the order, then, based on the Bill of Materials (BOM) recorded in Google Sheets, calculate the amount of raw materials that need to be consumed. Deduct the corresponding quantities from the raw material inventory table in Google Sheets, write the updated raw material inventory back to Google Sheets, and then, based on the updated raw material balances, recalculate the maximum producible quantities for all finished products. Finally, sync these maximum producible quantities to WooCommerce as the available stock for the products.'''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'


class UpdateMaterialInventoryS2LEnv(Env):
    """Update Material Inventory S2L Environment for material inventory management.
    
    This environment simulates a manufacturing/e-commerce scenario where the agent needs to:
    1. Read BOM (Bill of Materials) from Google Sheets
    2. Read material inventory data from Google Sheets
    3. Calculate max producible quantities based on material availability
    4. Update WooCommerce product stock accordingly
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        num_products: int = 5,
        num_materials: int = 10,
        materials_per_product: int = 3,
        num_orders: int = 10,
        seed: int = 42,
        difficulty: Optional[str] = None,
        verbose: bool = False,
        **_,
    ):
        """Initialize the Update Material Inventory S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            num_products: Number of products to generate (default: 5)
            num_materials: Number of raw materials (default: 10)
            materials_per_product: Average materials per product in BOM (default: 3)
            num_orders: Number of test orders to generate (default: 10)
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
        self.google_sheet_data_dir = self.data_dir / "google_sheets"

        # Clear task directory if it exists, then create it
        if Path(self.task_dir).exists():
            nfs_safe_rmtree(self.task_dir)
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        
        # Setup logging system
        self._setup_logging()

        # Configuration generation parameters
        self.num_products = num_products
        self.num_materials = num_materials
        self.materials_per_product = materials_per_product
        self.num_orders = num_orders
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
        self.logger = logging.getLogger(f"UpdateMaterialInventoryS2L_{id(self)}")
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
        """Reset environment and execute Update Material Inventory preprocessing.
        
        Steps include:
        1. Generate inventory data (products, materials, BOM)
        2. Initialize WooCommerce and Google Sheets databases
        3. Populate databases with generated data
        4. Generate test orders
        5. Calculate expected results for evaluation
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

            self.logger.info("Starting Update Material Inventory preprocessing...")
            self.logger.info("=" * 60)
            
            # Run preprocessing via subprocess
            self.logger.info("\nRunning preprocessing pipeline...")
            self.logger.info("=" * 60)

            try:
                import subprocess
                import os

                # Get preprocess directory
                env_dir = Path(__file__).parent
                preprocess_main_path = env_dir / "preprocess" / "main.py"

                # Check if preprocess exists
                if not preprocess_main_path.exists():
                    error_msg = f"Preprocess main.py not found at {preprocess_main_path}"
                    self.logger.error(error_msg)
                    return self._get_instructions(), {}

                # Set up environment variables for database directories
                env = os.environ.copy()
                env['WOOCOMMERCE_DATA_DIR'] = str(self.woocommerce_data_dir)
                env['GOOGLE_SHEET_DATA_DIR'] = str(self.google_sheet_data_dir)

                # Build command
                cmd = [
                    sys.executable,
                    str(preprocess_main_path),
                    "--agent_workspace", str(self.agent_workspace),
                    "--num-products", str(self.num_products),
                    "--num-materials", str(self.num_materials),
                    "--materials-per-product", str(self.materials_per_product),
                    "--num-orders", str(self.num_orders),
                    "--seed", str(self.seed),
                ]

                # Add difficulty preset if specified
                if self.difficulty:
                    cmd.extend(["--difficulty", self.difficulty])

                # Run preprocessing from env_dir
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd=str(env_dir),
                    env=env
                )

                if result.stdout:
                    self.logger.info(result.stdout)

                if result.returncode != 0:
                    self.logger.error("Preprocessing failed")
                    if result.stderr:
                        self.logger.error(result.stderr)
                    return self._get_instructions(), {}

                # Organize generated files
                self._organize_generated_files(env_dir)

            except Exception as e:
                self.logger.error(f"Error running preprocessing: {e}")
                self.logger.error(traceback.format_exc())
                return self._get_instructions(), {}
            
            self.logger.info("\nUpdate Material Inventory preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("WooCommerce products initialized")
            self.logger.info("Google Sheets BOM and inventory data populated")
            self.logger.info("Test orders generated")
            self.logger.info("Expected results calculated")
            self.logger.info("Agent workspace ready")
            
            return self._get_instructions(), {}
            
        except Exception as e:
            self.logger.error(f"Error during preprocessing: {e}")
            self.logger.error(traceback.format_exc())
            return self._get_instructions(), {}
    
    def _organize_generated_files(self, env_dir: Path) -> None:
        """Organize generated files after preprocessing.
        
        Preprocessing generates files in env_dir/groundtruth_workspace and env_dir/initial_workspace.
        This method copies initial_workspace to agent_workspace.
        
        Args:
            env_dir: Environment directory where preprocessing was run
        """
        self.logger.info("\nOrganizing generated files...")
        self.logger.info("=" * 60)
        
        try:
            # Check if groundtruth_workspace was created
            groundtruth_src = env_dir / "groundtruth_workspace"
            if groundtruth_src.exists():
                self.logger.info(f"  Groundtruth workspace created at {groundtruth_src}")
            
            # Copy initial_workspace to agent_workspace if it exists
            initial_workspace = env_dir / "initial_workspace"
            if initial_workspace.exists() and any(initial_workspace.iterdir()):
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
            else:
                # Create empty agent_workspace if initial_workspace doesn't exist or is empty
                self.agent_workspace.mkdir(parents=True, exist_ok=True)
                self.logger.info(f"  Created empty agent_workspace at {self.agent_workspace}")
            
            self.logger.info("Files organized successfully")
            
        except Exception as e:
            self.logger.warning(f"Error organizing files: {e}")
            self.logger.error(traceback.format_exc())

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        """Execute environment step and check agent's material inventory management results.
        
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
            
            self.logger.info("\nValidating material inventory management...")
            
            # Check if groundtruth workspace exists
            if not groundtruth_workspace.exists():
                self.logger.warning(f"Groundtruth workspace not found: {groundtruth_workspace}")
                self.logger.info("Evaluation may not have expected results to compare against")
            
            # Run evaluation via subprocess to avoid module conflicts
            try:
                import subprocess
                import os
                
                # Copy evaluation directory
                temp_eval_dir = Path(self.task_dir) / "temp_eval"
                temp_eval_dir.mkdir(parents=True, exist_ok=True)

                # Copy evaluation files
                eval_source_dir = env_dir / "evaluation"

                if eval_source_dir.exists():
                    for eval_file in eval_source_dir.glob("*.py"):
                        shutil.copy2(eval_file, temp_eval_dir / eval_file.name)
                else:
                    error_msg = f"Evaluation directory not found at {eval_source_dir}"
                    self.logger.error(error_msg)
                    return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}

                # Set up environment
                env = os.environ.copy()
                env['WOOCOMMERCE_DATA_DIR'] = str(self.woocommerce_data_dir)
                env['GOOGLE_SHEET_DATA_DIR'] = str(self.google_sheet_data_dir)

                
                cmd = [
                    sys.executable,
                    str(temp_eval_dir / "main.py"),
                    "--agent_workspace", str(self.agent_workspace)
                ]
                
                # Add groundtruth_workspace if it exists
                if groundtruth_workspace.exists():
                    cmd.extend(["--groundtruth_workspace", str(groundtruth_workspace)])
                
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd=str(temp_eval_dir),
                    env=env
                )
                
                if result.stdout:
                    self.logger.info(result.stdout)
                
                # Check if evaluation succeeded
                evaluation_passed = (result.returncode == 0)
                
                # Clean up temp directory
                nfs_safe_rmtree(temp_eval_dir)
                
                if evaluation_passed:
                    observation = self._create_success_observation()
                    reward = 1.0
                    info = {
                        "success": True,
                        "error": None,
                        "evaluation": "passed"
                    }
                else:
                    error_msg = "Material inventory management validation failed. Check the evaluation output above."
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
            "  ✓ Successfully read BOM data from Google Sheets\n"
            "  ✓ Successfully read material inventory from Google Sheets\n"
            "  ✓ Correctly calculated max producible quantities based on materials\n"
            "  ✓ Successfully updated WooCommerce product stock quantities\n"
            "  ✓ All inventory values match expected results\n"
            "\nCongratulations! You have successfully completed the material inventory management task.\n"
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
            "  - Did you read the BOM data from Google Sheets?\n"
            "  - Did you read the material inventory from Google Sheets?\n"
            "  - Did you calculate the max producible quantity for each product?\n"
            "  - Did you consider that each product needs multiple materials?\n"
            "  - Did you update the stock quantity for each product in WooCommerce?\n"
            "  - Do the updated stock quantities match the expected values?\n"
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

