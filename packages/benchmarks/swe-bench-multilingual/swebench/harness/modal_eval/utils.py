from pathlib import Path


def validate_modal_credentials():
    """
    Validate that Modal credentials exist by checking for ~/.modal.toml file.
    Raises an exception if credentials are not configured.
    """
    modal_config_path = Path.home() / ".modal.toml"
    if not modal_config_path.exists():
        raise RuntimeError(
            "~/.modal.toml not found - it looks like you haven't configured credentials for Modal.\n"
            "Run 'modal token new' in your terminal to configure credentials."
        )
