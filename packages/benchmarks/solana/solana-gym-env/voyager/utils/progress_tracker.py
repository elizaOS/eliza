import csv
import json
import logging
import os
from datetime import datetime
from typing import Dict, List, Any


class ProgressTracker:
    """
    Tracks and records agent progress, messages, and metrics to CSV and JSON files.
    """
    
    def __init__(self, ckpt_dir: str = "ckpt", resume: bool = False):
        self.ckpt_dir = ckpt_dir
        self.progress_file = os.path.join(ckpt_dir, "progress.csv")
        self.messages_file = os.path.join(ckpt_dir, "agent_messages.json")
        self.current_iteration = 0
        self.total_reward = 0
        self.completed_tasks = []
        self.messages_log = []
        
        # Ensure directory exists
        os.makedirs(ckpt_dir, exist_ok=True)
        
        if resume and os.path.exists(self.progress_file):
            self._load_existing_progress()
        else:
            self._init_progress_file()
    
    def _init_progress_file(self):
        """Initialize CSV file with headers."""
        with open(self.progress_file, 'w', newline='') as f:
            writer = csv.writer(f)
            writer.writerow([
                'iteration',
                'timestamp',
                'task',
                'task_success',
                'reward',
                'total_reward',
                'completed_tasks_count',
                'discovered_programs',
                'unique_instructions',
                'sol_balance',
                'error',
                'critique'
            ])
    
    def _load_existing_progress(self):
        """Load existing progress from CSV file."""
        try:
            with open(self.progress_file, 'r') as f:
                reader = csv.DictReader(f)
                rows = list(reader)
                if rows:
                    last_row = rows[-1]
                    self.current_iteration = int(last_row['iteration'])
                    self.total_reward = float(last_row['total_reward'])
                    self.completed_tasks = json.loads(last_row.get('completed_tasks', '[]'))
            
            # Load messages log
            if os.path.exists(self.messages_file):
                with open(self.messages_file, 'r') as f:
                    self.messages_log = json.load(f)
        except Exception as e:
            logging.error(f"Error loading existing progress: {e}")
    
    def record_iteration(
        self,
        task: str,
        success: bool,
        reward: float,
        observation: Dict[str, Any],
        error: str = None,
        critique: str = None,
        completed_tasks: List[str] = None
    ):
        """Record a single iteration's results."""
        self.current_iteration += 1
        self.total_reward += reward
        
        if completed_tasks:
            self.completed_tasks = completed_tasks
        
        # Prepare row data
        row = [
            self.current_iteration,
            datetime.now().isoformat(),
            task,
            success,
            reward,
            self.total_reward,
            len(self.completed_tasks),
            observation.get('discovered_programs', 0),
            observation.get('unique_instructions_found', 0),
            observation.get('sol_balance', 0),
            error or '',
            critique or ''
        ]
        
        # Append to CSV
        with open(self.progress_file, 'a', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(row)
        
        logging.info(
            f"\033[92m📊 Progress: Iteration {self.current_iteration} | "
            f"Task: {task} | Success: {success} | "
            f"Reward: +{reward} (Total: {self.total_reward}) | "
            f"Completed: {len(self.completed_tasks)}\033[0m"
        )
    
    def record_agent_message(
        self,
        agent_name: str,
        message_type: str,
        content: str,
        task: str = None
    ):
        """Record agent messages for later analysis."""
        message_entry = {
            'iteration': self.current_iteration,
            'timestamp': datetime.now().isoformat(),
            'agent': agent_name,
            'type': message_type,
            'task': task,
            'content': content
        }
        
        self.messages_log.append(message_entry)
        
        # Save to JSON file
        with open(self.messages_file, 'w') as f:
            json.dump(self.messages_log, f, indent=2)
    
    def get_summary(self) -> Dict[str, Any]:
        """Get a summary of current progress."""
        return {
            'current_iteration': self.current_iteration,
            'total_reward': self.total_reward,
            'completed_tasks_count': len(self.completed_tasks),
            'completed_tasks': self.completed_tasks,
            'success_rate': self._calculate_success_rate()
        }
    
    def _calculate_success_rate(self) -> float:
        """Calculate success rate from CSV file."""
        try:
            with open(self.progress_file, 'r') as f:
                reader = csv.DictReader(f)
                rows = list(reader)
                if not rows:
                    return 0.0
                
                successes = sum(1 for row in rows if row['task_success'] == 'True')
                return successes / len(rows) * 100
        except:
            return 0.0
    
    def export_summary_report(self):
        """Export a summary report of the run."""
        summary = self.get_summary()
        report_file = os.path.join(self.ckpt_dir, "summary_report.json")
        
        with open(report_file, 'w') as f:
            json.dump(summary, f, indent=2)
        
        logging.info(f"\033[92m📈 Summary report saved to {report_file}\033[0m")