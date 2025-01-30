import json
from pathlib import Path
from datetime import datetime
import logging

class CheckpointManager:
    def __init__(self):
        # Get the root directory (scripts/bug_hunt)
        self.root_dir = Path(__file__).parent.parent
        self.checkpoints_dir = self.root_dir / "checkpoints"
        self.checkpoints_dir.mkdir(exist_ok=True)

        # Setup logging
        self.logger = logging.getLogger(__name__)
        self.logger.debug(f"Initialized CheckpointManager with checkpoints dir: {self.checkpoints_dir}")

    def start_session(self, session_name: str) -> str:
        """Start a new analysis session"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        checkpoint_file = self.checkpoints_dir / f"{session_name}_{timestamp}.json"

        checkpoint_data = {
            "session_name": session_name,
            "started_at": datetime.now().isoformat(),
            "last_updated": datetime.now().isoformat(),
            "plugins_analyzed": [],
            "errors": []
        }

        self.logger.info(f"Starting new session: {session_name}")
        self.logger.info(f"Checkpoint file: {checkpoint_file}")

        with open(checkpoint_file, "w", encoding="utf-8") as f:
            json.dump(checkpoint_data, f, indent=2)

        return str(checkpoint_file)

    def save_plugin_progress(self, plugin_name: str, analysis_result: dict) -> None:
        """Save analysis results for a plugin"""
        latest_checkpoint = self._get_latest_checkpoint()
        if not latest_checkpoint:
            self.logger.error("No active session found")
            return

        with open(latest_checkpoint, "r", encoding="utf-8") as f:
            checkpoint_data = json.load(f)

        # Update checkpoint data
        checkpoint_data["plugins_analyzed"].append({
            "plugin_name": plugin_name,
            "analyzed_at": datetime.now().isoformat(),
            "results": analysis_result
        })
        checkpoint_data["last_updated"] = datetime.now().isoformat()

        with open(latest_checkpoint, "w", encoding="utf-8") as f:
            json.dump(checkpoint_data, f, indent=2)

        self.logger.info(f"Saved progress for plugin: {plugin_name}")

    def add_error(self, plugin_name: str, error_message: str) -> None:
        """Add an error to the current session"""
        latest_checkpoint = self._get_latest_checkpoint()
        if not latest_checkpoint:
            self.logger.error("No active session found")
            return

        with open(latest_checkpoint, "r", encoding="utf-8") as f:
            checkpoint_data = json.load(f)

        # Add error
        checkpoint_data["errors"].append({
            "plugin_name": plugin_name,
            "error": error_message,
            "timestamp": datetime.now().isoformat()
        })
        checkpoint_data["last_updated"] = datetime.now().isoformat()

        with open(latest_checkpoint, "w", encoding="utf-8") as f:
            json.dump(checkpoint_data, f, indent=2)

        self.logger.error(f"Added error for plugin {plugin_name}: {error_message}")

    def load_latest_session(self, session_name: str = None) -> dict:
        """Load the latest checkpoint for a session"""
        latest_checkpoint = self._get_latest_checkpoint(session_name)
        if not latest_checkpoint:
            return None

        with open(latest_checkpoint, "r", encoding="utf-8") as f:
            return json.load(f)

    def _get_latest_checkpoint(self, session_name: str = None) -> Path:
        """Get the path to the latest checkpoint file"""
        if not self.checkpoints_dir.exists():
            return None

        checkpoints = list(self.checkpoints_dir.glob("*.json"))
        if not checkpoints:
            return None

        if session_name:
            # Filter for specific session
            checkpoints = [c for c in checkpoints if session_name in c.stem]
            if not checkpoints:
                return None

        # Sort by modification time and return latest
        return sorted(checkpoints, key=lambda x: x.stat().st_mtime)[-1]

if __name__ == "__main__":
    # Test the checkpoint manager
    cm = CheckpointManager()
    cm.start_session("test_analysis")

    # Simulate some analysis
    cm.save_plugin_progress("plugin-test", {
        "errors_found": 5,
        "warnings": 10,
        "files_analyzed": ["test1.ts", "test2.ts"]
    })

    # Simulate an error
    cm.add_error("plugin-test", "Failed to parse file.ts")

    # Load the session back
    loaded = cm.load_latest_session("test_analysis")
    print(json.dumps(loaded, indent=2))
