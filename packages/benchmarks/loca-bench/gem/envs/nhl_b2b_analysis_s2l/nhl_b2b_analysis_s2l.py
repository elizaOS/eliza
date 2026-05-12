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
TASK_INSTRUCTION = '''Our coaching staff is currently working on season-long conditioning and rotation planning, with particular concern about “back-to-back games” (cases where the same team plays on two consecutive days, with exactly 1 day apart between game dates). Hockey is extremely demanding, and if a season contains many back-to-back sets—especially when the second game is often on the road—it can seriously impact player recovery and team performance.

Therefore, I'd like you to calculate how many back-to-back sets each team will face this season according to the NHL 2024–2025 schedule (all data is included in a Google spreadsheet named NHL Regular 2024-2025). Please also break down, for each team, the number of occurrences in each of the four home/away configurations: Home–Away (HA), Away–Home (AH), Home–Home (HH), and Away–Away (AA). Note: Directly reading all content from the Google Sheet would be very lengthy.

Organize the calculation results (do not include other content) into a google spreadsheet named `nhl_b2b_analysis`, and also save a local copy in the workspace as `nhl_b2b_analysis.csv`. The table headers should contain: `Team,HA,AH,HH,AA,Total`.

where Total represents the total number of back-to-back sets faced by each team across the season (i.e., the sum of HA, AH, HH, and AA).

This will make it easier for our coaches and data analysts to review and discuss later.'''

LOG_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
CONSOLE_LOG_FORMAT = '%(levelname)s - %(message)s'


class NhlB2bAnalysisS2LEnv(Env):
    """NHL B2B Analysis S2L Environment for analyzing back-to-back games.
    
    This environment simulates an NHL schedule analysis scenario where the agent needs to:
    1. Read NHL schedule data from Google Sheets
    2. Identify back-to-back games for each team
    3. Categorize back-to-back games by home/away configuration (HA, AH, HH, AA)
    4. Save analysis results to Google Sheets and local CSV file
    """
    
    def __init__(
        self,
        task_dir: Optional[str] = None,
        num_games: int = 2000,
        num_teams: int = 32,
        start_date: str = "2024-10-01",
        seed: int = 42,
        difficulty: Optional[str] = None,
        verbose: bool = False,
        **_,
    ):
        """Initialize the NHL B2B Analysis S2L Environment.
        
        Args:
            task_dir: Directory for task-related files
            num_games: Number of games to generate (default: 2000)
            num_teams: Number of teams (default: 32, uses real NHL teams up to 32)
            start_date: Season start date (default: 2024-10-01)
            seed: Random seed for reproducibility (default: 42)
            difficulty: Difficulty preset (easy/medium/hard/expert/extreme/massive/gigantic)
            verbose: Whether to output to console
        """
        super().__init__()
        self.task_dir = task_dir
        self.verbose = verbose

        # Setup directory paths
        self.agent_workspace = Path(self.task_dir) / "agent_workspace"
        self.data_dir = Path(self.task_dir) / "local_db"
        self.google_sheet_data_dir = self.data_dir / "google_sheets"

        # Clear task directory if it exists, then create it
        if Path(self.task_dir).exists():
            nfs_safe_rmtree(self.task_dir)
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        
        # Setup logging system
        self._setup_logging()

        # Configuration generation parameters
        self.num_games = num_games
        self.num_teams = num_teams
        self.start_date = start_date
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
        self.logger = logging.getLogger(f"NhlB2bAnalysisS2L_{id(self)}")
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
        """Reset environment and execute NHL B2B Analysis preprocessing.
        
        Steps include:
        1. Generate NHL schedule data with configurable difficulty
        2. Calculate groundtruth back-to-back analysis
        3. Initialize Google Sheets database
        4. Create spreadsheet with schedule data
        5. Copy initial workspace files to agent workspace
        
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

            # Ensure agent_workspace exists (for MCP servers)
            self.agent_workspace.mkdir(parents=True, exist_ok=True)
            self.logger.info(f"Agent workspace created at: {self.agent_workspace}")

            self.logger.info("Starting NHL B2B Analysis preprocessing...")
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
            
            # Call the preprocessing as a subprocess
            try:
                import subprocess
                import os
                
                # Set up environment variables for database directories
                env = os.environ.copy()
                env['GOOGLE_SHEET_DATA_DIR'] = str(self.google_sheet_data_dir)
                
                cmd = [
                    sys.executable,
                    str(preprocess_main_path),
                    "--agent_workspace", str(self.agent_workspace),
                    "--task_root", str(self.task_dir),  # Pass task_dir to avoid parallel conflicts
                    "--num-games", str(self.num_games),
                    "--num-teams", str(self.num_teams),
                    "--start-date", self.start_date,
                    "--seed", str(self.seed),
                ]
                
                # Add difficulty preset if specified
                if self.difficulty:
                    cmd.extend(["--difficulty", self.difficulty])
                
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
                
                # Move generated files to proper locations
                self._organize_generated_files(env_dir)
                
            except Exception as e:
                self.logger.error(f"Error running preprocessing: {e}")
                self.logger.error(traceback.format_exc())
                return self._get_instructions(), {}
            
            self.logger.info("\nNHL B2B Analysis preprocessing completed!")
            self.logger.info("=" * 60)
            self.logger.info("NHL schedule data generated")
            self.logger.info("Back-to-back analysis calculated")
            self.logger.info("Google Sheets database initialized")
            self.logger.info("Spreadsheet created with schedule data")
            self.logger.info("Groundtruth saved to groundtruth_workspace")
            self.logger.info("Agent workspace ready")
            
            return self._get_instructions(), {}
            
        except Exception as e:
            self.logger.error(f"Error during preprocessing: {e}")
            self.logger.error(traceback.format_exc())
            return self._get_instructions(), {}
    
    def _organize_generated_files(self, env_dir: Path) -> None:
        """Organize generated files from preprocessing to proper locations.

        Args:
            env_dir: Environment directory (code directory)
        """
        self.logger.info("\nOrganizing generated files...")
        self.logger.info("=" * 60)

        try:
            task_dir = Path(self.task_dir)

            # Check files directory
            dest_files = task_dir / "files"
            if dest_files.exists():
                self.logger.info(f"  Files directory exists at {dest_files}")
            else:
                # Try local fallback only
                source_files = env_dir / "files"
                if source_files.exists():
                    shutil.copytree(source_files, dest_files)
                    self.logger.info(f"  Copied files/ from {source_files}")
                else:
                    self.logger.warning(f"  Files directory not found!")

            # Check preprocess directory with generated files
            dest_preprocess = task_dir / "preprocess"
            if dest_preprocess.exists():
                generated_files = [
                    "generated_schedule.csv",
                    "generation_metadata.json"
                ]

                missing_files = []
                for file_name in generated_files:
                    file_path = dest_preprocess / file_name
                    if file_path.exists():
                        self.logger.info(f"  Found {file_name} in preprocess/")
                    else:
                        missing_files.append(file_name)
                        self.logger.warning(f"  Missing {file_name} in preprocess/")

                if missing_files:
                    self.logger.warning(f"  Total missing files in preprocess/: {len(missing_files)}")
            else:
                self.logger.warning(f"  Preprocess directory not found at {dest_preprocess}")

            # Check groundtruth_workspace directory
            dest_groundtruth = task_dir / "groundtruth_workspace"
            if dest_groundtruth.exists():
                self.logger.info(f"  Groundtruth workspace exists at {dest_groundtruth}")
            else:
                # Try local fallback only
                source_groundtruth = env_dir / "groundtruth_workspace"
                if source_groundtruth.exists():
                    shutil.copytree(source_groundtruth, dest_groundtruth)
                    self.logger.info(f"  Copied groundtruth_workspace/ from {source_groundtruth}")
                else:
                    self.logger.warning(f"  Groundtruth workspace not found!")

            # Verify agent_workspace exists
            if not self.agent_workspace.exists():
                self.agent_workspace.mkdir(parents=True, exist_ok=True)
                self.logger.info(f"  Created agent_workspace at {self.agent_workspace}")
            else:
                self.logger.info(f"  Agent workspace exists at {self.agent_workspace}")

            # Summary statistics
            total_dirs = sum(1 for d in [dest_files, dest_preprocess, dest_groundtruth, self.agent_workspace] if d.exists())
            self.logger.info(f"  Total directories verified: {total_dirs}/4")
            self.logger.info("Files organized successfully")

        except Exception as e:
            self.logger.error(f"Error organizing files: {e}")
            self.logger.error(traceback.format_exc())
            # Don't fail the task for organization errors - let evaluation handle missing files
            self.logger.warning("Continuing despite file organization errors")

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        """Execute environment step and check agent's NHL B2B analysis results.
        
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
            
            self.logger.info("\nValidating NHL B2B analysis results...")
            
            # Run evaluation via subprocess to avoid module conflicts
            try:
                import subprocess
                import os

                # Find evaluation directory
                eval_source_dir = env_dir / "evaluation"

                if not eval_source_dir.exists():
                    error_msg = f"Evaluation directory not found at {eval_source_dir}"
                    self.logger.error(error_msg)
                    return TERMINAL_STATE, 0.0, True, True, {"error": error_msg}

                # Set up environment
                env = os.environ.copy()
                env['GOOGLE_SHEET_DATA_DIR'] = str(self.google_sheet_data_dir)

                # Get groundtruth workspace path
                groundtruth_workspace = Path(self.task_dir) / "groundtruth_workspace"

                cmd = [
                    sys.executable,
                    str(eval_source_dir / "main.py"),
                    "--agent_workspace", str(self.agent_workspace),
                    "--groundtruth_workspace", str(groundtruth_workspace)
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
                    error_msg = "NHL B2B analysis validation failed. Check the evaluation output above."
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
            "  ✓ Local CSV file (nhl_b2b_analysis.csv) created correctly\n"
            "  ✓ Google Sheets file (nhl_b2b_analysis) created under NHL-B2B-Analysis folder\n"
            "  ✓ All teams identified with back-to-back games\n"
            "  ✓ Back-to-back configurations (HA, AH, HH, AA) calculated correctly\n"
            "  ✓ Total counts match expected values\n"
            "  ✓ Data format and headers are correct\n"
            "\nCongratulations! You have successfully completed the NHL B2B analysis task.\n"
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
            "  - Did you read the NHL schedule data from Google Sheets?\n"
            "  - Did you identify back-to-back games (games exactly 1 day apart)?\n"
            "  - Did you calculate HA, AH, HH, AA configurations correctly?\n"
            "  - Did you save results to both Google Sheets and local CSV?\n"
            "  - Is the Google Sheets file named 'nhl_b2b_analysis' under 'NHL-B2B-Analysis' folder?\n"
            "  - Is the local file named 'nhl_b2b_analysis.csv'?\n"
            "  - Do the headers match: Team,HA,AH,HH,AA,Total?\n"
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



