"""
Configuration Manager for Maestro Controller
Responsible for tool configuration and knowledge base setup
"""

import os
import json
import logging
from typing import Dict, Any

logger = logging.getLogger(__name__)


class ConfigManager:
    """Configuration manager responsible for tool configuration and knowledge base setup"""
    
    def __init__(self, 
        memory_root_path: str = os.getcwd(),
        memory_folder_name: str = "kb_s2",
        kb_release_tag: str = "v0.2.2",
    ):
        self.memory_root_path = memory_root_path
        self.memory_folder_name = memory_folder_name
        self.tools_config = {}
        self.tools_dict = {}
        self.flow_config: Dict[str, Any] = {}
        
    def load_tools_configuration(self) -> Dict[str, Any]:
        """Load tool configuration from configuration file"""
        try:
            tools_config_path = os.path.join(
                os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 
                "tools", "new_tools_config.json"
            )
            
            with open(tools_config_path, "r") as f:
                self.tools_config = json.load(f)
                logger.info(f"Loaded tools configuration from: {tools_config_path}")
                
                # Build tool dictionary, preserving all configuration fields
                for tool in self.tools_config["tools"]:
                    tool_name = tool["tool_name"]
                    # Copy all configuration fields, not just provider and model
                    self.tools_dict[tool_name] = tool.copy()
                    # Ensure model field exists (mapped from model_name)
                    if "model_name" in tool:
                        self.tools_dict[tool_name]["model"] = tool["model_name"]
                    
                logger.debug(f"Tools configuration loaded: {len(self.tools_dict)} tools")
                return self.tools_dict
                
        except Exception as e:
            logger.error(f"Failed to load tools configuration: {e}")
            return {}
    
    def setup_knowledge_base(self, platform: str) -> str:
        """Initialize agent's knowledge base path and check if it exists"""
        try:
            # Initialize agent's knowledge base path
            local_kb_path = os.path.join(self.memory_root_path, self.memory_folder_name)
            
            # Check if knowledge base exists
            kb_platform_path = os.path.join(local_kb_path, platform)
            if not os.path.exists(kb_platform_path):
                logger.warning(f"Knowledge base for {platform} platform not found in {local_kb_path}")
                os.makedirs(kb_platform_path, exist_ok=True)
                logger.info(f"Created directory: {kb_platform_path}")
            else:
                logger.info(f"Found local knowledge base path: {kb_platform_path}")
                
            return local_kb_path
            
        except Exception as e:
            logger.error(f"Failed to setup knowledge base: {e}")
            return self.memory_root_path
    
    def get_tools_dict(self) -> Dict[str, Any]:
        """Get tools dictionary"""
        return self.tools_dict
    
    def get_tools_config(self) -> Dict[str, Any]:
        """Get tools configuration"""
        return self.tools_config
    
    # ===== New: Centralized flow configuration management =====
    def load_flow_configuration(self) -> Dict[str, Any]:
        """Load flow configuration (currently mainly built-in defaults, can be extended to files/environment variables later)."""
        try:
            # Unified default threshold configuration
            self.flow_config = {
                # Task and state
                "max_state_switches": 1000, # default: 500
                # "max_state_duration_secs": 300, # default: 300
                # Quality check related
                # "quality_check_interval_secs": 300,  # Time interval since last quality check default: 300
                "first_quality_check_min_commands": 3,  # Number of commands to trigger first quality check default: 5
                # Consecutive same behavior and replanning
                # "repeated_action_min_consecutive": 3, # default: 3
                # "replan_long_execution_threshold": 15, # default: 15
                # Planning count limit
                # "plan_number_limit": 50,  # default: 50
                # Snapshots and main loop
                # "enable_snapshots": True,
                "enable_snapshots": False,
                "snapshot_interval_steps": 10,
                # "create_checkpoint_snapshots": True,
                "create_checkpoint_snapshots": False,
                "main_loop_sleep_secs": 0.1,
            }
        except Exception as e:
            logger.error(f"Failed to load flow configuration: {e}")
            # Fallback: at least provide an empty dictionary
            self.flow_config = {}
        return self.flow_config
    
    def get_flow_config(self) -> Dict[str, Any]:
        """Get flow configuration (load with defaults if not loaded)."""
        if not self.flow_config:
            return self.load_flow_configuration()
        return self.flow_config