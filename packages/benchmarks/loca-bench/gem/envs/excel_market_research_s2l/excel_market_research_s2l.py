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
TASK_INSTRUCTION = '''I am researching the sales performance of electronic products in the market. I have collected various complex market sales data, but our company's product categorization differs from that in the market. You need to help me complete this conversion. The 'Methodology' sheet describes the conversion relationship, where the first row corresponds to the original data's classification method, and the first column corresponds to our company's internal classification method. The 'RawData' sheet contains detailed data for all product categories. This table is located in `Market_Data.xlsx` in the workspace. You need to convert the raw data according to the company's internal classification, and then further calculate the annual growth rate of sales for a specific category (as well as the growth rate of the corresponding raw data). Please pay attention to the units in the raw data. Create a new file named `growth_rate.xlsx` in the workspace, you need to make sure that the `growth_rate.xlsx` can be loaded with `load_workbook(file_path, data_only=True)`. Please refer to the `Market_Data_Format.xlsx` file for the format and column names.

**Note:** Please check `task_specific.md` in the workspace for the specific target category and time range for this task instance.'''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'


class ExcelMarketResearchS2LEnv(Env):
    """Excel Market Research S2L Environment for market data analysis task.
    
    This environment simulates a market research scenario where the agent needs to:
    1. Read market data from Excel files
    2. Convert raw market categories to internal company categories
    3. Calculate year-over-year growth rates for specific categories
    4. Save results in the specified format
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        seed: int = 42,
        start_year: int = 1989,
        num_years: int = 20,
        num_raw_categories: int = 30,
        num_internal_categories: int = 5,
        difficulty: Optional[str] = None,
        verbose: bool = False,
        **_,
    ):
        """Initialize the Excel Market Research S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            seed: Random seed for reproducibility (default: 42)
            start_year: Starting year for data (default: 1989)
            num_years: Number of years of data (default: 20)
            num_raw_categories: Number of raw market categories (default: 30)
            num_internal_categories: Number of internal categories (default: 5)
            difficulty: Difficulty preset (easy/medium/hard/expert)
            verbose: Whether to output to console
        """
        super().__init__()
        self.task_dir = task_dir
        self.verbose = verbose

        # Setup directory paths
        self.agent_workspace = Path(self.task_dir) / "agent_workspace"
        self.data_dir = Path(self.task_dir) / "local_db"

        # Clear task directory if it exists, then create it
        if Path(self.task_dir).exists():
            nfs_safe_rmtree(self.task_dir)
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        
        # Setup logging system
        self._setup_logging()

        # Configuration generation parameters
        self.seed = seed
        self.start_year = start_year
        self.num_years = num_years
        self.num_raw_categories = num_raw_categories
        self.num_internal_categories = num_internal_categories
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
        self.logger = logging.getLogger(f"ExcelMarketResearchS2L_{id(self)}")
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
        """Reset environment and execute Excel Market Research preprocessing.
        
        Steps include:
        1. Generate market data Excel files with different difficulty levels
        2. Create initial workspace with Market_Data.xlsx
        3. Generate groundtruth for evaluation
        4. Copy initial workspace files to agent workspace
        
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

            self.logger.info("Starting Excel Market Research preprocessing...")
            self.logger.info("=" * 60)
            
            # Import preprocessing module using importlib to avoid conflicts
            try:
                import importlib.util
                env_dir = Path(__file__).parent
                preprocess_main_path = env_dir / "preprocess" / "main.py"
                
                # Load module with a unique name to avoid conflicts with other environments
                spec = importlib.util.spec_from_file_location(
                    f"excel_market_research_s2l_{id(self)}.preprocess_main",
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

                # Get the preprocess main script directly from environment directory
                preprocess_main = env_dir / "preprocess" / "main.py"

                # Check if existing files should be used
                existing_files = False
                initial_workspace = Path(self.task_dir) / "initial_workspace"
                if initial_workspace.exists() and any(initial_workspace.iterdir()):
                    existing_files = True
                    self.logger.info("  Found existing files in initial_workspace, will use --skip-generation")

                cmd = [
                    sys.executable,
                    str(preprocess_main),
                    "--task_root", str(self.task_dir),
                    "--agent_workspace", str(self.agent_workspace),
                    "--seed", str(self.seed),
                    "--start-year", str(self.start_year),
                    "--num-years", str(self.num_years),
                    "--num-raw-categories", str(self.num_raw_categories),
                    "--num-internal-categories", str(self.num_internal_categories),
                ]

                # Add difficulty preset if specified
                if self.difficulty:
                    cmd.extend(["--difficulty", self.difficulty])

                # Add skip generation if files exist
                if existing_files:
                    cmd.append("--skip-generation")

                self.logger.info("  Running preprocessing...")
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True
                )

                if result.stdout:
                    self.logger.info(result.stdout)

                if result.returncode != 0:
                    self.logger.error("Preprocessing failed")
                    if result.stderr:
                        self.logger.error(result.stderr)
                    return self._get_instructions(), {}

                self.logger.info("  Preprocessing completed successfully")

            except Exception as e:
                self.logger.error(f"Error running preprocessing: {e}")
                self.logger.error(traceback.format_exc())
                return self._get_instructions(), {}
            
            self.logger.info("\nExcel Market Research preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("Market data files generated")
            self.logger.info("Groundtruth generated")
            self.logger.info("Agent workspace ready")
            
            return self._get_instructions(), {}
            
        except Exception as e:
            self.logger.error(f"Error during preprocessing: {e}")
            self.logger.error(traceback.format_exc())
            return self._get_instructions(), {}
            
        except Exception as e:
            self.logger.warning(f"Error organizing files: {e}")
            self.logger.error(traceback.format_exc())
    
    def _install_python_dependencies(self) -> None:
        """Install Python dependencies in agent workspace for both execution methods.
        
        This ensures dependencies (openpyxl, pandas, numpy) are available whether
        agent uses python_execute (which uses uv run) or terminal (which uses direct python).
        
        Strategy:
        1. Create .venv in workspace and install dependencies (for uv run)
        2. Also install globally for terminal usage
        """
        self.logger.info("\nInstalling Python dependencies...")
        self.logger.info("=" * 60)
        
        try:
            import subprocess
            import os
            
            workspace_dir = str(self.agent_workspace)
            
            # Method 1: Create uv venv in workspace - Install dependencies for uv run (python_execute)
            try:
                self.logger.info("  Installing for python_execute (uv run)...")
                
                # Create venv in workspace
                result = subprocess.run(
                    ["uv", "venv", ".venv"],
                    cwd=workspace_dir,
                    capture_output=True,
                    text=True,
                    timeout=30
                )
                
                if result.returncode == 0:
                    self.logger.info("  ✓ Created .venv in workspace")
                    
                    # Install dependencies to the venv
                    result = subprocess.run(
                        ["uv", "pip", "install", "--python", ".venv/bin/python",
                         "openpyxl", "pandas", "numpy"],
                        cwd=workspace_dir,
                        capture_output=True,
                        text=True,
                        timeout=120
                    )
                    
                    if result.returncode == 0:
                        self.logger.info("  ✓ Dependencies installed to .venv (python_execute ready)")
                    else:
                        self.logger.warning(f"  uv pip install failed: {result.stderr}")
                else:
                    self.logger.warning(f"  uv venv creation failed: {result.stderr}")
                    
            except FileNotFoundError:
                self.logger.info("  uv not found, python_execute will install dependencies on first run")
            except subprocess.TimeoutExpired:
                self.logger.warning("  uv installation timed out")
            except Exception as e:
                self.logger.warning(f"  uv installation error: {e}")
            
            # Method 2: pip - Install globally for terminal usage
            try:
                self.logger.info("  Installing for terminal (direct python)...")
                result = subprocess.run(
                    ["pip", "install", "--quiet", "openpyxl", "pandas", "numpy"],
                    capture_output=True,
                    text=True,
                    timeout=60
                )
                
                if result.returncode == 0:
                    self.logger.info("  ✓ Dependencies installed via pip (terminal ready)")
                else:
                    self.logger.warning(f"  pip installation failed: {result.stderr}")
                    
            except Exception as e:
                self.logger.warning(f"  pip installation error: {e}")
            
            self.logger.info("  Dependencies installation completed")
                
        except Exception as e:
            self.logger.warning(f"Error installing dependencies: {e}")
            self.logger.warning("Dependencies not pre-installed, agent may need to run setup script")
            self.logger.error(traceback.format_exc())

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        """Execute environment step and check agent's growth rate calculation results.
        
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
            
            self.logger.info("\nValidating growth rate calculation...")
            
            # Validate groundtruth workspace existence
            if not groundtruth_workspace.exists():
                error_msg = f"Missing groundtruth workspace: {groundtruth_workspace}"
                self.logger.error(error_msg)
                return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}
            
            # Run evaluation via subprocess to avoid module conflicts
            try:
                import subprocess
                import os

                # Run evaluation directly from environment directory
                eval_main = env_dir / "evaluation" / "main.py"

                cmd = [
                    sys.executable,
                    str(eval_main),
                    "--agent_workspace", str(self.agent_workspace),
                    "--groundtruth_workspace", str(groundtruth_workspace)
                ]

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True
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
                    error_msg = "Growth rate calculation validation failed. Check the evaluation output above."
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
            "  ✓ growth_rate.xlsx file created successfully\n"
            "  ✓ All required columns present (Year, Growth Rate %, category columns)\n"
            "  ✓ Growth rate calculations are accurate (within 1% tolerance)\n"
            "  ✓ All category growth rates match groundtruth\n"
            "  ✓ File format matches expected structure\n"
            "\nCongratulations! You have successfully completed the market research task.\n"
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
            "  - Did you read the Market_Data.xlsx file correctly?\n"
            "  - Did you extract the conversion methodology from the Methodology sheet?\n"
            "  - Did you process the RawData sheet correctly?\n"
            "  - Did you pay attention to units (mn USD vs bn USD)?\n"
            "  - Did you convert all values to the same unit before calculation?\n"
            "  - Did you calculate the internal category values using conversion weights?\n"
            "  - Did you calculate year-over-year growth rates correctly?\n"
            "  - Did you save the results in the correct format (growth_rate.xlsx)?\n"
            "  - Did you include all required columns in the output file?\n"
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

