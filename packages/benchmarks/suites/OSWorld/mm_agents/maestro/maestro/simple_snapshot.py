import os
import shutil
import json
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any


class SimpleSnapshot:
    """Enhanced snapshot system - copy state folder, record screenshot IDs, and save key configuration parameters"""
    
    def __init__(self, runtime_dir: str):
        self.runtime_dir = Path(runtime_dir)
        self.snapshots_dir = self.runtime_dir / "snapshots"
        self.state_dir = self.runtime_dir / "state"
        self.screenshots_dir = self.runtime_dir / "cache" / "screens"
        
        # Ensure snapshot directory exists
        self.snapshots_dir.mkdir(exist_ok=True)
    
    def create_snapshot(self, description: str = "", snapshot_type: str = "manual", 
                       config_params: Optional[Dict[str, Any]] = None) -> str:
        """
        Create snapshot
        
        Args:
            description: Snapshot description
            snapshot_type: Snapshot type
            config_params: Key configuration parameters, including:
                - tools_dict: Tools configuration dictionary
                - platform: Platform information
                - enable_search: Search toggle
                - env_password: Environment password
                - enable_takeover: Takeover toggle
                - enable_rag: RAG toggle
                - backend: Backend type
                - max_steps: Maximum steps
        """
        # Generate snapshot ID
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        snapshot_id = f"snapshot_{timestamp}"
        
        # Create snapshot directory
        snapshot_dir = self.snapshots_dir / snapshot_id
        snapshot_dir.mkdir(exist_ok=True)
        
        # 1. Copy entire state folder
        if self.state_dir.exists():
            state_backup = snapshot_dir / "state"
            # If target directory already exists, delete it first
            if state_backup.exists():
                shutil.rmtree(state_backup)
            shutil.copytree(self.state_dir, state_backup)
            # print(f"✅ Copied state folder to: {state_backup}")
        
        # 2. Get current screenshot ID list
        screenshot_ids = []
        if self.screenshots_dir.exists():
            # Support multiple image formats
            for ext in ['*.png', '*.jpg', '*.jpeg', '*.webp']:
                for screenshot_file in self.screenshots_dir.glob(ext):
                    screenshot_ids.append(screenshot_file.stem)
        
        # 3. Record snapshot metadata and configuration parameters
        metadata = {
            "snapshot_id": snapshot_id,
            "timestamp": timestamp,
            "description": description,
            "type": snapshot_type,
            "screenshot_ids": screenshot_ids,
            "state_folder_copied": True,
            "config_params": config_params or {}
        }
        
        # Save metadata
        metadata_file = snapshot_dir / "metadata.json"
        with open(metadata_file, 'w', encoding='utf-8') as f:
            json.dump(metadata, f, indent=2, ensure_ascii=False)
        
        # print(f"🎯 Snapshot created successfully: {snapshot_id}")
        # print(f"   Description: {description}")
        # print(f"   Screenshot count: {len(screenshot_ids)}")
        # if config_params:
        #     print(f"   Config parameters: {list(config_params.keys())}")
        
        return snapshot_id
    
    def restore_snapshot(self, snapshot_id: str, target_runtime_dir: Optional[str] = None) -> Dict[str, Any]:
        """
        Restore snapshot
        
        Returns:
            Dictionary containing restore information and configuration parameters
        """
        snapshot_dir = self.snapshots_dir / snapshot_id
        
        if not snapshot_dir.exists():
            print(f"❌ Snapshot does not exist: {snapshot_id}")
            return {}
        
        # Read metadata
        metadata_file = snapshot_dir / "metadata.json"
        if not metadata_file.exists():
            print(f"❌ Snapshot metadata file does not exist: {metadata_file}")
            return {}
        
        with open(metadata_file, 'r', encoding='utf-8') as f:
            metadata = json.load(f)
        
        # Determine target directory
        if target_runtime_dir is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            target_path = self.runtime_dir.parent / f"{self.runtime_dir.name}_restored_from_{snapshot_id}_{timestamp}"
        else:
            target_path = Path(target_runtime_dir)
        
        target_path.mkdir(parents=True, exist_ok=True)
        
        # 1. Restore state folder
        state_backup = snapshot_dir / "state"
        if state_backup.exists():
            target_state = target_path / "state"
            if target_state.exists():
                shutil.rmtree(target_state)
            shutil.copytree(state_backup, target_state)
            print(f"✅ Restored state folder to: {target_state}")
        
        # 2. Restore cache/screens folder
        target_cache = target_path / "cache"
        target_screenshots = target_cache / "screens"
        target_screenshots.mkdir(parents=True, exist_ok=True)
        
        restored_count = 0
        for screenshot_id in metadata.get("screenshot_ids", []):
            # Try multiple image formats
            source_file = None
            target_file = None
            for ext in ['.png', '.jpg', '.jpeg', '.webp']:
                test_source = self.screenshots_dir / f"{screenshot_id}{ext}"
                if test_source.exists():
                    source_file = test_source
                    target_file = target_screenshots / f"{screenshot_id}{ext}"
                    break
            
            if source_file and target_file:
                shutil.copy2(source_file, target_file)
                restored_count += 1
        
        print(f"✅ Restored {restored_count} screenshots to: {target_screenshots}")
        
        # 3. Create display.json file (if it doesn't exist)
        target_display = target_path / "display.json"
        if not target_display.exists():
            default_display = {
                "restored_from_snapshot": snapshot_id,
                "restore_time": datetime.now().isoformat(),
                "operations": {}
            }
            with open(target_display, 'w', encoding='utf-8') as f:
                json.dump(default_display, f, indent=2, ensure_ascii=False)
            print(f"✅ Created display.json file")
        
        # Save restore information
        restore_info = {
            "restored_from": snapshot_id,
            "restore_time": datetime.now().strftime("%Y%m%d_%H%M%S"),
            "target_directory": str(target_path),
            "screenshots_restored": restored_count
        }
        
        restore_file = target_path / "restore_info.json"
        with open(restore_file, 'w', encoding='utf-8') as f:
            json.dump(restore_info, f, indent=2, ensure_ascii=False)
        
        print(f"🎉 Snapshot restored successfully!")
        print(f"   Target directory: {target_path}")
        print(f"   Restored screenshots: {restored_count}")
        
        # Return restore information and configuration parameters
        return {
            "restore_info": restore_info,
            "target_directory": str(target_path),
            "config_params": metadata.get("config_params", {}),
            "snapshot_metadata": metadata
        }
    

    def list_snapshots(self) -> list:
        """List all snapshots"""
        snapshots = []
        
        for snapshot_dir in self.snapshots_dir.iterdir():
            if snapshot_dir.is_dir():
                metadata_file = snapshot_dir / "metadata.json"
                if metadata_file.exists():
                    try:
                        with open(metadata_file, 'r', encoding='utf-8') as f:
                            metadata = json.load(f)
                        snapshots.append(metadata)
                    except:
                        continue
        
        # Sort by time
        snapshots.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
        return snapshots
    
    def delete_snapshot(self, snapshot_id: str) -> bool:
        """Delete snapshot"""
        snapshot_dir = self.snapshots_dir / snapshot_id
        
        if not snapshot_dir.exists():
            print(f"❌ Snapshot does not exist: {snapshot_id}")
            return False
        
        try:
            shutil.rmtree(snapshot_dir)
            print(f"✅ Snapshot deleted successfully: {snapshot_id}")
            return True
        except Exception as e:
            print(f"❌ Failed to delete snapshot: {e}")
            return False


# Usage example
if __name__ == "__main__":
    # Use current runtime directory
    runtime_dir = "runtime/20250824_162344"
    
    # Create snapshot system
    snapshot_system = SimpleSnapshot(runtime_dir)
    
    # Mock configuration parameters
    config_params = {
        "tools_dict": {"example": "config"},
        "platform": "darwin",
        "enable_search": True,
        "env_password": "osworld-public-evaluation"
    }
    
    # Create snapshot
    snapshot_id = snapshot_system.create_snapshot("Test enhanced snapshot", "test", config_params)
    
    # List all snapshots
    snapshots = snapshot_system.list_snapshots()
    print(f"\n📋 Existing snapshot count: {len(snapshots)}")
    
    # Restore snapshot
    # restore_result = snapshot_system.restore_snapshot(snapshot_id)
    # print(f"Restore result: {restore_result}")