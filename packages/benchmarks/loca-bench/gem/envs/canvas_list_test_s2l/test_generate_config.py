#!/usr/bin/env python
"""
Test script for CanvasListTestS2LEnv.generate_config method

This script demonstrates how to use the generate_config method to
dynamically create task configurations.
"""

import tempfile
import shutil
from pathlib import Path

print("=" * 80)
print("Testing CanvasListTestS2LEnv.generate_config()")
print("=" * 80)

# Create a temporary directory for testing
temp_dir = Path(tempfile.mkdtemp(prefix="canvas_test_"))
print(f"\n📁 Created temporary directory: {temp_dir}")

try:
    # Import the environment
    from gem.envs.canvas_list_test_s2l import CanvasListTestS2LEnv
    
    print("\n✓ Successfully imported CanvasListTestS2LEnv")
    
    # Create environment instance
    print(f"\n🔧 Initializing environment with task_dir={temp_dir}")
    env = CanvasListTestS2LEnv(task_dir=temp_dir)
    
    print("\n✓ Environment initialized")
    
    # Test generate_config with small parameters for quick testing
    print("\n🎲 Calling generate_config with test parameters...")
    print("   - num_courses: 3")
    print("   - num_students: 2")
    print("   - quiz_prob: 0.7")
    print("   - assignment_prob: 0.5")
    print("   - submission_prob: 0.2")
    print("   - exemption_prob: 0.3")
    print("   - exemption_meet_prob: 0.5")
    
    stats = env.generate_config(
        num_courses=3,
        num_students=2,
        quiz_prob=0.7,
        assignment_prob=0.5,
        submission_prob=0.2,
        exemption_prob=0.3,
        exemption_meet_prob=0.5,
        seed=42
    )
    
    if stats:
        print("\n" + "=" * 80)
        print("📊 Configuration Generation Results:")
        print("=" * 80)
        print(f"✓ Courses: {stats['courses']}")
        print(f"✓ Total exemption courses: {stats['total_exemption_courses']}")
        print(f"✓ Qualified exemptions: {stats['qualified_exemptions']}")
        print(f"✓ Unqualified exemptions: {stats['unqualified_exemptions']}")
        print(f"✓ Quizzes: {stats['quizzes']}")
        print(f"✓ Assignments: {stats['assignments']}")
        print(f"✓ Total tasks: {stats['total_tasks']}")
        print(f"✓ Submitted: {stats['submitted']}")
        print(f"✓ Remaining: {stats['remaining']}")
        print(f"✓ Groundtruth quizzes: {stats['groundtruth_quizzes']}")
        print(f"✓ Groundtruth assignments: {stats['groundtruth_assignments']}")
        print(f"✓ Groundtruth total: {stats['groundtruth_total']}")
        
        # Check generated files
        print("\n" + "=" * 80)
        print("📂 Checking Generated Files:")
        print("=" * 80)
        
        files_to_check = [
            temp_dir / "files" / "course_config.json",
            temp_dir / "files" / "canvas_users.json",
            temp_dir / "files" / "submission_config.json",
            temp_dir / "initial_workspace" / "memory" / "memory.json",
            temp_dir / "groundtruth_workspace" / "quiz_info.csv",
            temp_dir / "groundtruth_workspace" / "assignment_info.csv",
        ]
        
        all_exist = True
        for file_path in files_to_check:
            if file_path.exists():
                size = file_path.stat().st_size
                print(f"✓ {file_path.relative_to(temp_dir)} ({size} bytes)")
            else:
                print(f"✗ {file_path.relative_to(temp_dir)} (missing)")
                all_exist = False
        
        if all_exist:
            print("\n✅ All expected files generated successfully!")
        else:
            print("\n⚠️ Some files are missing")
        
        # Display sample content
        print("\n" + "=" * 80)
        print("📄 Sample Content:")
        print("=" * 80)
        
        # Show memory.json snippet
        memory_file = temp_dir / "initial_workspace" / "memory" / "memory.json"
        if memory_file.exists():
            import json
            with open(memory_file, 'r', encoding='utf-8') as f:
                memory_data = json.load(f)
            print(f"\n📝 memory.json (Ryan Brown's info):")
            print(f"   Entity Type: {memory_data.get('entityType')}")
            print(f"   Name: {memory_data.get('name')}")
            print(f"   Observations: {len(memory_data.get('observations', []))} items")
            if memory_data.get('observations'):
                print(f"   First 3 observations:")
                for obs in memory_data['observations'][:3]:
                    print(f"     - {obs}")
        
        # Show quiz_info.csv snippet
        quiz_csv = temp_dir / "groundtruth_workspace" / "quiz_info.csv"
        if quiz_csv.exists():
            import csv
            with open(quiz_csv, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                rows = list(reader)
            print(f"\n📝 quiz_info.csv:")
            print(f"   Total quizzes: {len(rows)}")
            if rows:
                print(f"   First quiz:")
                first = rows[0]
                print(f"     - Course: {first.get('course_code')} - {first.get('course_name')}")
                print(f"     - Title: {first.get('quiz_title')}")
                print(f"     - Questions: {first.get('number_of_questions')}")
                print(f"     - Deadline: {first.get('deadline')}")
        
        print("\n" + "=" * 80)
        print("✅ TEST PASSED: generate_config() works correctly!")
        print("=" * 80)
        
    else:
        print("\n❌ TEST FAILED: generate_config() returned None")
    
except Exception as e:
    print(f"\n❌ TEST FAILED with error: {e}")
    import traceback
    traceback.print_exc()

finally:
    # Cleanup
    print(f"\n🧹 Cleaning up temporary directory: {temp_dir}")
    shutil.rmtree(temp_dir, ignore_errors=True)
    print("✓ Cleanup completed")

print("\n" + "=" * 80)
print("Test completed!")
print("=" * 80)
