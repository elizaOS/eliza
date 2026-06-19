"""
QwenClawBench Task Library

This module provides task loading and parsing functionality for the QwenClawBench
benchmarking system.
"""

import logging
import re
from pathlib import Path
from typing import Dict, List, Optional, Any

import yaml


logger = logging.getLogger(__name__)


class Task:
    """Represents a single benchmark task."""
    
    def __init__(
        self,
        task_id: str,
        name: str,
        category: str,
        grading_type: str,
        timeout_seconds: int,
        workspace_files: List[Dict[str, str]],
        prompt: str,
        expected_behavior: str,
        grading_criteria: List[str],
        automated_checks: Optional[str] = None,
        llm_judge_rubric: Optional[str] = None,
        grading_weights: Optional[Dict[str, float]] = None,
        file_path: Optional[Path] = None,
        frontmatter: Optional[Dict[str, Any]] = None,
    ):
        self.task_id = task_id
        self.name = name
        self.category = category
        self.grading_type = grading_type
        self.timeout_seconds = timeout_seconds
        self.workspace_files = workspace_files
        self.prompt = prompt
        self.expected_behavior = expected_behavior
        self.grading_criteria = grading_criteria
        self.automated_checks = automated_checks
        self.llm_judge_rubric = llm_judge_rubric
        self.grading_weights = grading_weights
        self.file_path = file_path
        self.frontmatter = frontmatter or {}
    
    def __repr__(self) -> str:
        return f"Task(id={self.task_id}, name={self.name}, category={self.category})"
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert task to dictionary representation."""
        return {
            'task_id': self.task_id,
            'name': self.name,
            'category': self.category,
            'grading_type': self.grading_type,
            'timeout_seconds': self.timeout_seconds,
            'workspace_files': self.workspace_files,
            'prompt': self.prompt,
            'expected_behavior': self.expected_behavior,
            'grading_criteria': self.grading_criteria,
            'has_automated_checks': self.automated_checks is not None,
            'has_llm_judge_rubric': self.llm_judge_rubric is not None,
            'grading_weights': self.grading_weights,
            'frontmatter': self.frontmatter,
        }


class TaskLoader:
    """Loads and parses task files from the tasks directory."""
    
    def __init__(self, tasks_dir: Path):
        self.tasks_dir = tasks_dir
        logger.info(f"Initialized TaskLoader with directory: {tasks_dir}")
    
    def load_all_tasks(self) -> List[Task]:
        """Load all task files from the tasks directory."""
        tasks = []
        task_files = sorted(self.tasks_dir.glob("task_*.md"))
        
        logger.info(f"Found {len(task_files)} task files")
        
        for task_file in task_files:
            try:
                task = self.load_task(task_file)
                tasks.append(task)
                logger.info(f"Successfully loaded task: {task.task_id}")
            except Exception as e:
                logger.error(f"Failed to load task from {task_file}: {e}", exc_info=True)
        
        logger.info(f"Successfully loaded {len(tasks)} tasks")
        return tasks
    
    def load_task(self, task_file: Path) -> Task:
        """Load and parse a single task file."""
        logger.debug(f"Loading task from: {task_file}")
        
        content = task_file.read_text(encoding='utf-8')
        
        # Extract YAML frontmatter
        frontmatter_match = re.match(r'^---\s*\n(.*?)\n---\s*\n(.*)$', content, re.DOTALL)
        if not frontmatter_match:
            raise ValueError(f"No YAML frontmatter found in {task_file}")
        
        frontmatter_text = frontmatter_match.group(1)
        body_text = frontmatter_match.group(2)

        # Strip tracing-only fields that may contain problematic content (XML, colons, etc.)
        # source_query can be multi-line (quoted string); match until next YAML key or end
        frontmatter_text = re.sub(
            r'^source_query:\s*.*?(?=\n\w+:\s|\n---|\Z)',
            '',
            frontmatter_text,
            flags=re.MULTILINE | re.DOTALL,
        )
        frontmatter_text = re.sub(r'^source_line_number:.*$', '', frontmatter_text, flags=re.MULTILINE)

        # Parse YAML frontmatter
        try:
            metadata = yaml.safe_load(frontmatter_text)
        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML frontmatter in {task_file}: {e}")
        
        # Extract sections from body
        sections = self._parse_sections(body_text)
        
        # Extract grading criteria
        grading_criteria = self._extract_grading_criteria(
            sections.get('Grading Criteria', '')
        )
        
        # Create Task object
        task = Task(
            task_id=metadata.get('id', ''),
            name=metadata.get('name', ''),
            category=metadata.get('category', ''),
            grading_type=metadata.get('grading_type', 'automated'),
            timeout_seconds=metadata.get('timeout_seconds', 120),
            workspace_files=metadata.get('workspace_files', []),
            prompt=sections.get('Prompt', '').strip(),
            expected_behavior=sections.get('Expected Behavior', '').strip(),
            grading_criteria=grading_criteria,
            automated_checks=sections.get('Automated Checks', None),
            llm_judge_rubric=sections.get('LLM Judge Rubric', None),
            grading_weights=metadata.get('grading_weights', None),
            file_path=task_file,
            frontmatter=metadata,
        )
        
        return task
    
    def _parse_sections(self, body: str) -> Dict[str, str]:
        """Parse markdown sections from task body."""
        sections = {}
        current_section = None
        current_content = []
        
        for line in body.split('\n'):
            # Check for section headers (## Header)
            header_match = re.match(r'^##\s+(.+)$', line)
            if header_match:
                # Save previous section
                if current_section:
                    sections[current_section] = '\n'.join(current_content).strip()
                
                # Start new section
                current_section = header_match.group(1)
                current_content = []
            else:
                if current_section:
                    current_content.append(line)
        
        # Save last section
        if current_section:
            sections[current_section] = '\n'.join(current_content).strip()
        
        return sections
    
    def _extract_grading_criteria(self, criteria_text: str) -> List[str]:
        """Extract grading criteria from checklist format."""
        criteria = []
        for line in criteria_text.split('\n'):
            # Match checklist items: - [ ] or - [x]
            match = re.match(r'^-\s+\[[ x]\]\s+(.+)$', line.strip())
            if match:
                criteria.append(match.group(1))
        return criteria
