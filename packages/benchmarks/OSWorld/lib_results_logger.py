#!/usr/bin/env python3
"""
Thread-safe results logging for OSWorld evaluations.
Appends task completion results to results.json in real-time.
"""

import json
import os
import time
import fcntl
from pathlib import Path
from typing import Dict, Any, Optional


def extract_domain_from_path(result_path: str) -> str:
    """
    Extract domain/application from result directory path.
    Expected structure: results/{action_space}/{observation_type}/{model}/{domain}/{task_id}/
    """
    path_parts = Path(result_path).parts
    if len(path_parts) >= 2:
        return path_parts[-2]  # Second to last part should be domain
    return "unknown"


def append_task_result(
    task_id: str,
    domain: str, 
    score: float,
    result_dir: str,
    args: Any,
    error_message: Optional[str] = None
) -> None:
    """
    Thread-safely append a task result to results.json.
    
    Args:
        task_id: UUID of the task
        domain: Application domain (chrome, vlc, etc.)
        score: Task score (0.0 or 1.0)
        result_dir: Full path to the task result directory
        args: Command line arguments object
        error_message: Error message if task failed
    """
    # Create result entry
    result_entry = {
        "application": domain,
        "task_id": task_id,
        "status": "error" if error_message else "success",
        "score": score,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
    }
    
    if error_message:
        result_entry["err_message"] = error_message
    
    # Determine summary directory and results file path
    # Extract base result directory from args
    base_result_dir = Path(args.result_dir)
    summary_dir = base_result_dir / "summary"
    results_file = summary_dir / "results.json"
    
    # Ensure summary directory exists
    summary_dir.mkdir(parents=True, exist_ok=True)
    
    # Thread-safe JSON append with file locking
    try:
        with open(results_file, 'a+') as f:
            # Lock the file for exclusive access
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            
            try:
                # Move to beginning to read existing content
                f.seek(0)
                content = f.read().strip()
                
                # Parse existing JSON array or create new one
                if content:
                    try:
                        existing_results = json.loads(content)
                        if not isinstance(existing_results, list):
                            existing_results = []
                    except json.JSONDecodeError:
                        existing_results = []
                else:
                    existing_results = []
                
                # Add new result
                existing_results.append(result_entry)
                
                # Write back the complete JSON array
                f.seek(0)
                f.truncate()
                json.dump(existing_results, f, indent=2)
                f.write('\n')  # Add newline for readability
                
            finally:
                # Always unlock the file
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
                
        print(f"📝 Logged result: {domain}/{task_id} -> {result_entry['status']} (score: {score})")
        
    except Exception as e:
        # Don't let logging errors break the main evaluation
        print(f"⚠️  Failed to log result for {task_id}: {e}")


def log_task_completion(example: Dict, result: float, result_dir: str, args: Any) -> None:
    """
    Convenience wrapper for logging successful task completion.
    
    Args:
        example: Task configuration dictionary
        result: Task score
        result_dir: Path to task result directory  
        args: Command line arguments
    """
    task_id = example.get('id', 'unknown')
    domain = extract_domain_from_path(result_dir)
    append_task_result(task_id, domain, result, result_dir, args)


def log_task_error(example: Dict, error_msg: str, result_dir: str, args: Any) -> None:
    """
    Convenience wrapper for logging task errors.
    
    Args:
        example: Task configuration dictionary
        error_msg: Error message
        result_dir: Path to task result directory
        args: Command line arguments
    """
    task_id = example.get('id', 'unknown')
    domain = extract_domain_from_path(result_dir) 
    append_task_result(task_id, domain, 0.0, result_dir, args, error_msg)