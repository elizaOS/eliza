# file_utils.py
import json
import os
import logging
from pathlib import Path
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ========= File Lock Tools =========
@contextmanager
def locked(path: Path, mode: str):
    """File lock context manager for cross-platform compatibility"""
    if os.name == "nt":
        # Windows implementation
        import msvcrt
        import time as _t
        
        # Always use UTF-8 encoding for text files on Windows
        if 'b' in mode:
            f = open(path, mode)
        else:
            f = open(path, mode, encoding="utf-8")
        try:
            while True:
                try:
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    _t.sleep(0.01)
            yield f
        finally:
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            f.close()
    else:
        # Unix-like systems implementation
        import fcntl
        
        # Always use UTF-8 encoding for text files on Unix-like systems
        if 'b' in mode:
            f = open(path, mode)
        else:
            f = open(path, mode, encoding="utf-8")
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            yield f
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            f.close()

# ========= Safe JSON Operations =========
def safe_json_dump(data: Any, file_handle, **kwargs) -> None:
    """Safely dump JSON data with proper encoding handling"""
    kwargs.setdefault('ensure_ascii', False)
    kwargs.setdefault('indent', 2)

    try:
        json.dump(data, file_handle, **kwargs)
    except UnicodeEncodeError as e:
        logger.warning(f"UnicodeEncodeError during JSON dump: {e}. Falling back to ASCII mode.")
        kwargs['ensure_ascii'] = True
        json.dump(data, file_handle, **kwargs)

def safe_json_load(file_handle) -> Any:
    """Safely load JSON data with proper encoding handling"""
    try:
        return json.load(file_handle)
    except UnicodeDecodeError as e:
        logger.warning(f"UnicodeDecodeError during JSON load: {e}. Attempting recovery.")
        file_handle.seek(0)
        content = file_handle.read()

        # Try common encodings
        for encoding in ['utf-8-sig', 'latin1', 'cp1252']:
            try:
                if isinstance(content, bytes):
                    decoded_content = content.decode(encoding)
                else:
                    decoded_content = content
                return json.loads(decoded_content)
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue

        logger.error("Failed to decode JSON with all attempted encodings. Returning empty data.")
        return {}

def safe_write_json(path: Path, data: Any) -> None:
    """Safely write JSON data to file with atomic operation"""
    tmp = path.with_suffix(".tmp")
    try:
        with locked(tmp, "w") as f:
            safe_json_dump(data, f)
            f.flush()
            os.fsync(f.fileno())
        tmp.replace(path)
    except Exception as e:
        logger.error(f"Failed to write JSON to {path}: {e}")
        if tmp.exists():
            try:
                tmp.unlink()
            except Exception:
                pass
        raise

def safe_read_json(path: Path, default: Any = None) -> Any:
    """Safely read JSON data from file"""
    try:
        with locked(path, "r") as f:
            return safe_json_load(f)
    except Exception as e:
        logger.warning(f"Failed to read JSON from {path}: {e}")
        return default if default is not None else []

# ========= Safe Text File Operations =========
def safe_write_text(path: Path, content: str) -> None:
    """Safely write text to file with UTF-8 encoding"""
    try:
        path.write_text(content, encoding='utf-8')
    except UnicodeEncodeError as e:
        logger.warning(f"UnicodeEncodeError writing to {path}: {e}. Using error handling.")
        path.write_text(content, encoding='utf-8', errors='replace')

def safe_read_text(path: Path) -> str:
    """Safely read text from file with proper encoding handling"""
    try:
        return path.read_text(encoding='utf-8')
    except UnicodeDecodeError as e:
        logger.warning(f"UnicodeDecodeError reading {path}: {e}. Trying alternative encodings.")
        for encoding in ['utf-8-sig', 'latin1', 'cp1252', 'gbk']:
            try:
                return path.read_text(encoding=encoding)
            except UnicodeDecodeError:
                continue

        logger.error(f"Failed to decode {path} with all encodings. Using error replacement.")
        return path.read_text(encoding='utf-8', errors='replace')

# ========= File Management Utilities =========
def ensure_directory(path: Path) -> None:
    """Ensure directory exists, create if necessary"""
    path.mkdir(parents=True, exist_ok=True)

def safe_file_operation(operation_name: str, file_path: Path, operation_func, *args, **kwargs):
    """Generic safe file operation wrapper with error handling"""
    try:
        return operation_func(*args, **kwargs)
    except FileNotFoundError:
        logger.error(f"{operation_name}: File not found: {file_path}")
        raise
    except PermissionError:
        logger.error(f"{operation_name}: Permission denied: {file_path}")
        raise
    except Exception as e:
        logger.error(f"{operation_name}: Unexpected error with {file_path}: {e}")
        raise

def backup_file(file_path: Path, backup_suffix: str = ".backup") -> Path:
    """Create a backup of a file"""
    backup_path = file_path.with_suffix(file_path.suffix + backup_suffix)
    try:
        if file_path.exists():
            import shutil
            shutil.copy2(file_path, backup_path)
            logger.info(f"Backup created: {backup_path}")
        return backup_path
    except Exception as e:
        logger.error(f"Failed to create backup of {file_path}: {e}")
        raise 