"""
Configuration loader for daily_stock_analysis.
"""

import os
import yaml


def load_config(path: str = "config/settings.yaml") -> dict:
    """Load YAML configuration file."""
    # Resolve path relative to project root
    if not os.path.isabs(path):
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        path = os.path.join(project_root, path)

    if not os.path.exists(path):
        raise FileNotFoundError(f"Config file not found: {path}")

    with open(path) as f:
        config = yaml.safe_load(f)

    # Override with environment variables
    if os.environ.get("FEISHU_WEBHOOK_URL"):
        config["feishu_webhook_url"] = os.environ["FEISHU_WEBHOOK_URL"]
    if os.environ.get("FEISHU_APP_ID"):
        config["feishu_app_id"] = os.environ["FEISHU_APP_ID"]
    if os.environ.get("FEISHU_APP_SECRET"):
        config["feishu_app_secret"] = os.environ["FEISHU_APP_SECRET"]

    return config
