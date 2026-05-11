#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Canvas Exam Arrangement Task Preprocessing Wrapper
This module wraps the preprocessing logic for the environment
"""

import asyncio
import sys
import subprocess
from pathlib import Path
from datetime import datetime
from gem.utils.filesystem import nfs_safe_rmtree

def run_preprocessing(
    agent_workspace: str,
    task_dir: str,
    seed: int = 42,
    num_courses: int = 10,
    canvas_exam_rate: float = 0.7,
    email_exam_rate: float = 0.2,
    no_exam_rate: float = 0.1,
    tbd_rate: float = 0.2,
    exemption_rate: float = 0.0,
    past_exam_rate: float = 0.15,
    distraction_emails: int = 3,
    distraction_announcements: int = 2,
    difficulty: str = "medium"
) -> bool:
    """
    Run the complete preprocessing pipeline
    
    Args:
        agent_workspace: Path to agent workspace
        task_dir: Path to task directory
        seed: Random seed
        num_courses: Number of courses
        canvas_exam_rate: Rate of exams announced via Canvas
        email_exam_rate: Rate of exams announced via Email
        no_exam_rate: Rate of courses with no final exam
        tbd_rate: Rate of TBD exam info
        exemption_rate: Rate of exempted courses (not used, set to 0)
        past_exam_rate: Probability of past exams
        distraction_emails: Number of distraction emails
        distraction_announcements: Number of distraction announcements per course
        difficulty: Difficulty level
        
    Returns:
        True if preprocessing succeeded
    """
    try:
        print("🚀 Canvas Exam Arrangement Preprocessing...")
        print("=" * 60)
        
        # Add current directory to path
        current_dir = Path(__file__).parent
        if str(current_dir) not in sys.path:
            sys.path.insert(0, str(current_dir))
        
        task_root = Path(task_dir)
        
        # Step 0: Generate exam data
        print("\n" + "=" * 60)
        print("STEP 0: Generate Exam Data")
        print("=" * 60)
        
        if not generate_exam_data(
            task_root=task_root,
            seed=seed,
            num_courses=num_courses,
            canvas_exam_rate=canvas_exam_rate,
            email_exam_rate=email_exam_rate,
            no_exam_rate=no_exam_rate,
            tbd_rate=tbd_rate,
            exemption_rate=exemption_rate,
            past_exam_rate=past_exam_rate,
            distraction_emails=distraction_emails,
            distraction_announcements=distraction_announcements,
            difficulty=difficulty
        ):
            print("❌ Data generation failed!")
            return False
        
        # Import setup modules using importlib to avoid conflicts with other environments
        import importlib.util
        
        # Load main_simplified with unique namespace
        main_simplified_path = current_dir / "main_simplified.py"
        spec_main = importlib.util.spec_from_file_location(
            "canvas_arrange_exam_s2l.main_simplified", 
            main_simplified_path
        )
        main_simplified_module = importlib.util.module_from_spec(spec_main)
        spec_main.loader.exec_module(main_simplified_module)
        setup_courses_main = main_simplified_module.run_with_args
        
        # Load inject_emails_simplified with unique namespace
        inject_emails_path = current_dir / "inject_emails_simplified.py"
        spec_inject = importlib.util.spec_from_file_location(
            "canvas_arrange_exam_s2l.inject_emails_simplified",
            inject_emails_path
        )
        inject_emails_module = importlib.util.module_from_spec(spec_inject)
        spec_inject.loader.exec_module(inject_emails_module)
        inject_exam_emails_from_config_simplified = inject_emails_module.inject_exam_emails_from_config_simplified
        
        # Step 1: Clear Canvas database
        print("\n" + "=" * 60)
        print("STEP 1: Clean Canvas Database")
        print("=" * 60)
        asyncio.run(setup_courses_main(delete=True, agent_workspace=agent_workspace, task_dir=task_dir))
        
        # Step 2: Create Canvas courses
        print("\n" + "=" * 60)
        print("STEP 2: Create Canvas Courses")
        print("=" * 60)
        asyncio.run(setup_courses_main(agent_workspace=agent_workspace, task_dir=task_dir))
        
        # Step 3: Inject exam notification emails
        print("\n" + "=" * 60)
        print("STEP 3: Inject Exam Notification Emails")
        print("=" * 60)
        
        # Set email time to January 1, 2025 at 10:00 AM
        email_time = datetime(2025, 1, 1, 10, 0, 0)
        email_timestamp = email_time.timestamp()
        print(f"⏰ Email time: {email_time.strftime('%Y-%m-%d %H:%M:%S')}")
        
        # Email config file path
        config_file = task_root / 'files' / 'email_config.json'
        
        # Inject emails
        email_success = inject_exam_emails_from_config_simplified(
            str(config_file),
            email_timestamp=email_timestamp,
            clear_inbox=True,
            add_distractions=True,
            agent_workspace=agent_workspace
        )
        
        if not email_success:
            print("⚠️ Email injection failed, but continuing...")
        else:
            print("✅ Exam notification emails injected")
        
        # Step 4: Copy initial workspace files
        print("\n" + "=" * 60)
        print("STEP 4: Copy Initial Workspace Files")
        print("=" * 60)
        copy_initial_workspace(current_dir, agent_workspace)
        
        print("\n" + "=" * 60)
        print("🎉 Canvas Exam Arrangement Preprocessing Complete!")
        print("=" * 60)
        print("✅ Configuration files generated")
        print("✅ Canvas database initialized")
        print("✅ Courses created and published")
        print("✅ Exam notification emails injected")
        print("✅ Initial workspace files copied")
        print(f"\n💡 Using local JSON database")
        
        return True
        
    except Exception as e:
        print(f"❌ Preprocessing error: {e}")
        import traceback
        traceback.print_exc()
        return False


def generate_exam_data(
    task_root: Path,
    seed: int = 42,
    num_courses: int = 10,
    canvas_exam_rate: float = 0.7,
    email_exam_rate: float = 0.2,
    no_exam_rate: float = 0.1,
    tbd_rate: float = 0.2,
    exemption_rate: float = 0.0,
    past_exam_rate: float = 0.15,
    distraction_emails: int = 3,
    distraction_announcements: int = 2,
    difficulty: str = "medium"
) -> bool:
    """
    Generate exam arrangement data
    
    Args:
        task_root: Task root directory
        seed: Random seed
        num_courses: Number of courses
        canvas_exam_rate: Rate of exams announced via Canvas
        email_exam_rate: Rate of exams announced via Email
        no_exam_rate: Rate of courses with no final exam
        tbd_rate: Rate of TBD exam info
        exemption_rate: Rate of exempted courses (default 0.0, not used)
        past_exam_rate: Probability of past exams
        distraction_emails: Number of distraction emails
        distraction_announcements: Number of distraction announcements per course
        difficulty: Difficulty level
        
    Returns:
        True if generation succeeded
    """
    print("=" * 60)
    print("Generating Canvas Exam Data")
    print("=" * 60)
    
    try:
        generator_script = Path(__file__).parent / "generate_exam_data.py"
        
        if not generator_script.exists():
            print(f"❌ Generator script not found: {generator_script}")
            return False
        
        # Build command
        cmd = [
            sys.executable,
            str(generator_script),
            "--output-dir", str(task_root),
            "--seed", str(seed),
            "--num-courses", str(num_courses),
            "--canvas-exam-rate", str(canvas_exam_rate),
            "--email-exam-rate", str(email_exam_rate),
            "--no-exam-rate", str(no_exam_rate),
            "--tbd-rate", str(tbd_rate),
            "--exemption-rate", str(exemption_rate),
            "--past-exam-rate", str(past_exam_rate),
            "--distraction-emails", str(distraction_emails),
            "--distraction-announcements", str(distraction_announcements),
            "--difficulty", difficulty
        ]
        
        print(f"🎲 Generation parameters:")
        print(f"   Difficulty: {difficulty}")
        print(f"   Courses: {num_courses}")
        print(f"   Canvas exam rate: {canvas_exam_rate:.0%}")
        print(f"   Email exam rate: {email_exam_rate:.0%}")
        print(f"   No exam rate: {no_exam_rate:.0%}")
        print(f"   TBD rate: {tbd_rate:.0%}")
        print(f"   Seed: {seed}")
        
        # Run generator
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).parent)
        )
        
        if result.stdout:
            print(result.stdout)
        
        if result.returncode != 0:
            print(f"❌ Data generation failed:")
            if result.stderr:
                print(result.stderr)
            return False
        
        print("✅ Data generation successful!")
        return True
        
    except Exception as e:
        print(f"❌ Data generation error: {e}")
        import traceback
        traceback.print_exc()
        return False


def copy_initial_workspace(env_dir: Path, agent_workspace: str) -> bool:
    """
    Copy initial workspace files to agent workspace
    
    Args:
        env_dir: Environment directory
        agent_workspace: Agent workspace path
        
    Returns:
        True if successful
    """
    try:
        import shutil
        
        # Source directory
        initial_workspace_dir = env_dir / "initial_workspace"
        if not initial_workspace_dir.exists():
            print(f"⚠️ Initial workspace directory not found: {initial_workspace_dir}")
            return False
        
        # Target directory
        target_dir = Path(agent_workspace)
        target_dir.mkdir(parents=True, exist_ok=True)
        
        # Copy Excel template
        exam_schedule = initial_workspace_dir / "exam_schedule.xlsx"
        if exam_schedule.exists():
            shutil.copy2(exam_schedule, target_dir / "exam_schedule.xlsx")
            print(f"  ✓ Copied exam_schedule.xlsx to {target_dir}")
        else:
            print(f"  ⚠️ exam_schedule.xlsx not found in initial workspace")
        
        # Copy memory directory if exists
        memory_dir = initial_workspace_dir / "memory"
        if memory_dir.exists():
            # Copy to target_dir/memory (original location)
            target_memory = target_dir / "memory"
            if target_memory.exists():
                nfs_safe_rmtree(target_memory)
            shutil.copytree(memory_dir, target_memory)
            print(f"  ✓ Copied memory directory to {target_dir}")

            # Also copy to target_dir/memory/memories for memory_tool access
            target_memories = target_memory / "memories"
            target_memories.mkdir(parents=True, exist_ok=True)
            for item in memory_dir.iterdir():
                if item.is_file():
                    shutil.copy2(item, target_memories / item.name)
                elif item.is_dir():
                    target_subdir = target_memories / item.name
                    if target_subdir.exists():
                        nfs_safe_rmtree(target_subdir)
                    shutil.copytree(item, target_subdir)
            print(f"  ✓ Copied memory files to {target_memories} for memory_tool access")
        
        print("✅ Initial workspace files copied successfully")
        return True
        
    except Exception as e:
        print(f"❌ Error copying initial workspace files: {e}")
        import traceback
        traceback.print_exc()
        return False

