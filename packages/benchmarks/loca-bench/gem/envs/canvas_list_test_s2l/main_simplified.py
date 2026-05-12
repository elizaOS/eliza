#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Canvas Course Setup - Simplified Version using Local Database
Directly operates on local JSON database instead of using Canvas API
"""

import sys
import os
import json
import random
from pathlib import Path
from argparse import ArgumentParser
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Any, Optional
from gem.utils.filesystem import nfs_safe_rmtree
# Set random seed for reproducibility
random.seed(42)

# Add gem to path for importing database
current_dir = Path(__file__).parent

from mcp_convert.mcps.canvas.database_utils import CanvasDatabase

from .extract_quiz_info import parse_quiz_data, parse_assign_data


class SimplifiedCanvasSetup:
    """Setup Canvas courses using local JSON database"""

    def __init__(self, data_dir: str = None, agent_workspace: str = None, task_dir: Path = None):
        """
        Initialize the setup

        Args:
            data_dir: Path to Canvas data directory
            agent_workspace: Path to agent workspace (for local_db location)
            task_dir: Path to task directory (overrides config file locations)
        """
        # Store for courses with exemption mechanism
        self.exemption_courses = {}  # Dict: course_code -> exemption_score

        # Store agent_workspace for later use
        self.agent_workspace = agent_workspace

        # Determine task directory
        if task_dir:
            self.task_dir = Path(task_dir)
        else:
            self.task_dir = current_dir.parent

        if data_dir is None:
            if agent_workspace:
                workspace_parent = Path(agent_workspace).parent
                data_dir = str(workspace_parent / "local_db" / "canvas")
                print(f"[DIR] Using local database directory: {data_dir}")
            else:
                # Use task_dir's local_db
                data_dir = str(self.task_dir / "local_db" / "canvas")
                print(f"[DIR] Using local database directory: {data_dir}")

        # Create data directory if it doesn't exist
        Path(data_dir).mkdir(parents=True, exist_ok=True)

        self.db = CanvasDatabase(data_dir=data_dir)
        self.config_file = self.task_dir / 'files' / 'course_config.json'
        self.users_file = self.task_dir / 'files' / 'canvas_users.json'
        self.courses_data = None
        self.users_data = None
        self.account_id = 1  # Default account

    def load_data(self) -> bool:
        """Load course and user data from JSON files"""
        try:
            print("[LOAD] Loading configuration files...")

            # Load course config
            with open(self.config_file, 'r', encoding='utf-8') as f:
                self.courses_data = json.load(f)
            print(f"   Loaded {len(self.courses_data.get('courses', []))} courses from config")

            # Load users - handle both array and object formats
            with open(self.users_file, 'r', encoding='utf-8') as f:
                users_raw = json.load(f)

            # Convert to standard format if needed
            if isinstance(users_raw, list):
                # If it's an array, wrap it in a dict
                self.users_data = {'users': users_raw}
            elif isinstance(users_raw, dict):
                # If it's already a dict, use as is
                self.users_data = users_raw
            else:
                raise ValueError(f"Unexpected users data format: {type(users_raw)}")

            print(f"   Loaded {len(self.users_data.get('users', []))} users")

            return True

        except FileNotFoundError as e:
            print(f"[ERROR] Configuration file not found: {e}")
            return False
        except json.JSONDecodeError as e:
            print(f"[ERROR] Invalid JSON format: {e}")
            return False

    def clear_database(self) -> bool:
        """Clear all data from the database"""
        print("\n[CLEAR] Clearing database...")

        try:
            # Clear all collections
            self.db.courses = {}
            self.db.users = {}
            self.db.enrollments = {}
            self.db.assignments = {}
            self.db.submissions = {}
            self.db.quizzes = {}
            self.db.discussions = {}
            self.db.announcements = {}
            self.db.modules = {}
            self.db.module_items = {}
            self.db.pages = {}
            self.db.files = {}
            self.db.folders = {}
            self.db.rubrics = {}
            self.db.conversations = {}
            self.db.notifications = {}
            self.db.calendar_events = {}
            self.db.grades = {}

            # Keep accounts - we need at least one account
            if not self.db.accounts:
                self.db.accounts = {
                    "1": {
                        "id": 1,
                        "name": "Default Account",
                        "workflow_state": "active",
                        "parent_account_id": None,
                        "root_account_id": None,
                        "uuid": "account-uuid-1",
                        "default_storage_quota_mb": 500,
                        "default_user_storage_quota_mb": 50,
                        "default_group_storage_quota_mb": 50,
                        "default_time_zone": "America/Denver"
                    }
                }

            # Save all cleared data
            self.db._save_json_file("courses.json", self.db.courses)
            self.db._save_json_file("users.json", self.db.users)
            self.db._save_json_file("enrollments.json", self.db.enrollments)
            self.db._save_json_file("assignments.json", self.db.assignments)
            self.db._save_json_file("submissions.json", self.db.submissions)
            self.db._save_json_file("quizzes.json", self.db.quizzes)
            self.db._save_json_file("discussions.json", self.db.discussions)
            self.db._save_json_file("announcements.json", self.db.announcements)
            self.db._save_json_file("modules.json", self.db.modules)
            self.db._save_json_file("module_items.json", self.db.module_items)
            self.db._save_json_file("pages.json", self.db.pages)
            self.db._save_json_file("files.json", self.db.files)
            self.db._save_json_file("folders.json", self.db.folders)
            self.db._save_json_file("rubrics.json", self.db.rubrics)
            self.db._save_json_file("conversations.json", self.db.conversations)
            self.db._save_json_file("notifications.json", self.db.notifications)
            self.db._save_json_file("calendar_events.json", self.db.calendar_events)
            self.db._save_json_file("grades.json", self.db.grades)
            self.db._save_json_file("accounts.json", self.db.accounts)

            print(f"[SUCCESS] Database cleared successfully")
            return True

        except Exception as e:
            print(f"[ERROR] Failed to clear database: {e}")
            return False

    def find_or_create_user(self, name: str, email: str, password: str = None) -> Optional[int]:
        """Find user by email or create new user"""
        # Search for existing user
        for user_id, user in self.db.users.items():
            if user.get('primary_email') == email or user.get('login_id') == email:
                return int(user_id)

        # Create new user
        try:
            user_data = {
                "name": name,
                "short_name": name.split()[0] if ' ' in name else name,
                "login_id": email,
                "email": email,
                "password": password if password else "default_password_123"
            }
            pseudonym_data = {"unique_id": email}
            user = self.db.create_user(self.account_id, user_data, pseudonym_data)
            return user['id']
        except Exception as e:
            print(f"   [ERROR] Failed to create user {name}: {e}")
            return None

    def create_quiz_for_course(self, course_id: int, quiz_config: Dict, credits: int = None) -> Optional[int]:
        """Create a quiz for a course"""
        try:
            quiz_data = {
                "title": quiz_config.get("title", "Quiz"),
                "description": quiz_config.get("description", ""),
                "quiz_type": quiz_config.get("quiz_type", "assignment"),
                "time_limit": quiz_config.get("time_limit"),
                "shuffle_answers": quiz_config.get("shuffle_answers", False),
                "show_correct_answers": quiz_config.get("show_correct_answers", True),
                "allowed_attempts": quiz_config.get("allowed_attempts", 1),
                "scoring_policy": quiz_config.get("scoring_policy", "keep_highest"),
                "points_possible": quiz_config.get("points_possible", 100),
                "due_at": quiz_config.get("due_at"),
                "published": True,
                "credits": credits
            }

            quiz = self.db.create_quiz(course_id, quiz_data)
            quiz_id = quiz['id']

            # Add questions
            questions = quiz_config.get("questions", [])
            for question_data in questions:
                self.db.add_quiz_question(course_id, quiz_id, question_data)

            return quiz_id

        except Exception as e:
            print(f"   [ERROR] Failed to create quiz: {e}")
            return None

    def create_assignment_for_course(self, course_id: int, assignment_config: Dict) -> Optional[int]:
        """Create an assignment for a course"""
        try:
            assignment_data = {
                "name": assignment_config.get("name", "Assignment"),
                "description": assignment_config.get("description", ""),
                "points_possible": assignment_config.get("points_possible", 100),
                "due_at": assignment_config.get("due_at"),
                "submission_types": assignment_config.get("submission_types", ["online_text_entry"]),
                "published": True
            }

            assignment = self.db.create_assignment(course_id, assignment_data)
            return assignment['id']

        except Exception as e:
            print(f"   [ERROR] Failed to create assignment: {e}")
            return None

    def create_announcement_for_course(self, course_id: int, announcement_config: Dict) -> Optional[int]:
        """Create an announcement for a course"""
        try:
            announcement_data = {
                "title": announcement_config.get("title", "Announcement"),
                "content": announcement_config.get("content", "")
            }

            announcement = self.db.create_announcement(course_id, announcement_data)
            return announcement['id']

        except Exception as e:
            print(f"   [ERROR] Failed to create announcement: {e}")
            return None

    def load_exemption_courses(self) -> None:
        """Load courses with exemption mechanism from course_config.json"""
        try:
            if not self.courses_data or 'courses' not in self.courses_data:
                print("   [INFO] No course data loaded")
                return

            # Extract courses with exemption_score
            for course in self.courses_data['courses']:
                if 'exemption_score' in course:
                    course_code = course.get('course_code')
                    exemption_score = course.get('exemption_score')
                    if course_code and exemption_score:
                        self.exemption_courses[course_code] = exemption_score

            if self.exemption_courses:
                print(f"   Found {len(self.exemption_courses)} courses with exemption mechanism:")
                for code, score in self.exemption_courses.items():
                    print(f"      - {code}: exemption score = {score}")
            else:
                print("   [INFO] No courses with exemption mechanism found")

        except Exception as e:
            print(f"   [WARN] Failed to load exemption courses: {e}")

    def create_exemption_announcement(self, course_id: int, course_code: str, course_name: str,
                                     exemption_score: int) -> Optional[int]:
        """Create exemption announcement for a course with exemption mechanism"""
        try:
            title = f"Course Exemption Policy - {course_code}"
            content = f"""Dear Students,

This is an important announcement regarding the course exemption policy for {course_name} ({course_code}).

Exemption Policy:
This course offers an exemption opportunity based on qualification examination performance.

Exemption Requirements:
   - Minimum Required Score: {exemption_score}
   - Examination: Qualification/Placement Test

If You Meet the Exemption Requirement:
Students who achieve the required score of {exemption_score} or higher in the qualification examination do NOT have to complete any of the following for this course:
   - Assignments
   - Quizzes
   - Exams

You will be fully exempt from all coursework requirements for {course_code}.

Important Notes:
   - Check your personal records to verify your exemption status
   - If you have met the exemption requirement, you can safely skip all course activities
   - Exemption is automatic once the score requirement is met

Best regards,
Course Administration"""

            announcement_data = {
                "title": title,
                "content": content
            }

            announcement = self.db.create_announcement(course_id, announcement_data)
            return announcement['id']

        except Exception as e:
            print(f"   [ERROR] Failed to create exemption announcement: {e}")
            return None

    def create_courses(self) -> bool:
        """Create all courses from configuration"""
        print("\n[COURSES] Creating courses...")

        if not self.courses_data or 'courses' not in self.courses_data:
            print("[ERROR] No courses data loaded")
            return False

        # Load courses with exemption mechanism
        print("\n[EXEMPTION] Loading courses with exemption mechanism...")
        self.load_exemption_courses()

        courses = self.courses_data['courses']
        created_count = 0

        for course_config in courses:
            try:
                course_name = course_config.get('name', 'Untitled Course')
                course_code = course_config.get('course_code', 'UNKNOWN')

                print(f"\n   [COURSE] Creating course: {course_code} - {course_name}")

                # Create course
                course = self.db.create_course(
                    account_id=self.account_id,
                    course_data={
                        "name": course_name,
                        "course_code": course_code,
                        "workflow_state": "available",  # Published by default
                        "is_public": True,
                        "is_public_to_auth_users": True
                    }
                )
                course_id = course['id']
                print(f"      Course created (ID: {course_id})")

                # Add teacher
                teacher_email = course_config.get('teacher', 'teacher@example.com')
                teacher_password = course_config.get('teacher_password', 'teacher_password_123')
                teacher_id = self.find_or_create_user(f"Teacher {course_code}", teacher_email, teacher_password)
                if teacher_id:
                    self.db.enroll_user(course_id, teacher_id, "TeacherEnrollment", "active")
                    print(f"      Teacher enrolled: {teacher_email}")

                # Check if this course has exemption mechanism and create exemption announcement first
                if course_code in self.exemption_courses:
                    exemption_score = self.exemption_courses[course_code]
                    exemption_ann_id = self.create_exemption_announcement(
                        course_id, course_code, course_name, exemption_score
                    )
                    if exemption_ann_id:
                        print(f"      Exemption policy announcement created (ID: {exemption_ann_id}) [EXEMPT]")

                # Create quiz if configured
                if 'quiz' in course_config and course_config['quiz']:
                    credits = course_config.get('credits')
                    quiz_id = self.create_quiz_for_course(course_id, course_config['quiz'], credits)
                    if quiz_id:
                        print(f"      Quiz created (ID: {quiz_id})")

                # Create assignment if configured
                if 'assignment' in course_config and course_config['assignment']:
                    assignment_id = self.create_assignment_for_course(course_id, course_config['assignment'])
                    if assignment_id:
                        print(f"      Assignment created (ID: {assignment_id})")

                # Create announcement if configured
                if 'announcement' in course_config and course_config['announcement']:
                    announcement_id = self.create_announcement_for_course(course_id, course_config['announcement'])
                    if announcement_id:
                        print(f"      Announcement created (ID: {announcement_id})")

                created_count += 1

            except Exception as e:
                print(f"   [ERROR] Failed to create course {course_config.get('course_code', 'UNKNOWN')}: {e}")
                continue

        print(f"\n[SUCCESS] Created {created_count}/{len(courses)} courses")
        return created_count > 0

    def enroll_students(self) -> bool:
        """Enroll students in courses"""
        print("\n[ENROLL] Enrolling students...")

        if not self.users_data or 'users' not in self.users_data:
            print("[ERROR] No users data loaded")
            return False

        # Get all users (treat all as students if no role field)
        all_users = self.users_data['users']
        # Filter students if role field exists, otherwise use all users
        students = [u for u in all_users if u.get('role', 'student') == 'student']

        enrolled_count = 0

        # Enroll students in all courses
        for course_id, course in self.db.courses.items():
            course_code = course.get('course_code', 'UNKNOWN')
            print(f"\n   [COURSE] Enrolling students in {course_code}...")

            for student in students:
                try:
                    # Handle both 'name' and 'full_name' fields
                    name = student.get('name') or student.get('full_name') or 'Unknown'
                    email = student.get('email', f'student{enrolled_count}@example.com')
                    password = student.get('password', 'student_password_123')

                    student_id = self.find_or_create_user(name, email, password)
                    if student_id:
                        self.db.enroll_user(int(course_id), student_id, "StudentEnrollment", "active")
                        enrolled_count += 1

                except Exception as e:
                    print(f"      [ERROR] Failed to enroll {student.get('name') or student.get('full_name', 'Unknown')}: {e}")
                    continue

        print(f"\n[SUCCESS] Total enrollments: {enrolled_count}")
        return enrolled_count > 0

    def submit_student_assignments(self) -> bool:
        """Submit assignments for Ryan Brown based on submission_config.json"""
        print("\n[SUBMIT] Submitting student assignments for Ryan Brown...")

        # Target student: Ryan Brown
        target_student_email = "ryan.brown93@mcp.com"

        # Load submission config
        submission_config_file = self.task_dir / 'files' / 'submission_config.json'
        target_courses = []

        if submission_config_file.exists():
            try:
                with open(submission_config_file, 'r', encoding='utf-8') as f:
                    submission_config = json.load(f)
                target_courses = list(submission_config.keys())
                print(f"   [CONFIG] Loaded submission config: {len(target_courses)} courses")
            except Exception as e:
                print(f"   [WARN] Failed to load submission_config.json: {e}")
                print(f"   [INFO] Will not submit any assignments")
                return True  # Not an error, just no submissions
        else:
            print(f"   [INFO] No submission_config.json found, will not submit any assignments")
            return True  # Not an error, just no submissions

        if not target_courses:
            print(f"   [INFO] No courses in submission config, skipping submissions")
            return True

        print(f"   [TARGET] Target courses: {', '.join(target_courses)}")

        # Find Ryan Brown in users
        ryan_user_id = None
        for user_id, user in self.db.users.items():
            email = user.get('primary_email') or user.get('login_id')
            if email == target_student_email:
                ryan_user_id = int(user_id)
                print(f"   Found Ryan Brown (ID: {ryan_user_id})")
                break

        if not ryan_user_id:
            print(f"   [ERROR] Ryan Brown not found in database")
            return False

        submitted_count = 0
        total_assignments = 0

        # Get courses Ryan is enrolled in that match target courses
        ryan_courses = []
        for course_key, enrollments in self.db.enrollments.items():
            for user_id_str, enrollment in enrollments.items():
                if int(user_id_str) == ryan_user_id and enrollment.get('type') == 'StudentEnrollment':
                    course_id = enrollment.get('course_id')
                    if course_id:
                        course = self.db.courses.get(str(course_id))
                        if course:
                            course_code = course.get('course_code', '')
                            course_name = course.get('name', 'Unknown')
                            # Only include target courses
                            if course_code in target_courses:
                                ryan_courses.append(course_id)
                                print(f"   Ryan enrolled in target course: {course_name} ({course_code}, ID: {course_id})")

        if not ryan_courses:
            print(f"   [ERROR] Ryan Brown is not enrolled in any target courses ({', '.join(target_courses)})")
            return False

        # Submit assignments for each course Ryan is enrolled in
        for course_id in ryan_courses:
            # Get course info
            course = self.db.courses.get(str(course_id))
            course_name = course.get('name', 'Unknown') if course else 'Unknown'

            print(f"\n   [COURSE] Processing course: {course_name}")

            # Get assignments for this course
            course_assignments = [
                (assignment_id, assignment)
                for assignment_id, assignment in self.db.assignments.items()
                if assignment.get('course_id') == int(course_id)
            ]

            if not course_assignments:
                print(f"      [INFO] No assignments found in {course_name}")
                continue

            for assignment_id, assignment in course_assignments:
                assignment_name = assignment.get('name', 'Assignment')
                total_assignments += 1

                try:
                    # Generate a random submission time (1-5 days ago)
                    days_ago = random.randint(1, 5)
                    hours_ago = random.randint(1, 23)
                    minutes_ago = random.randint(1, 59)
                    submitted_time = datetime.now(timezone.utc) - timedelta(
                        days=days_ago,
                        hours=hours_ago,
                        minutes=minutes_ago
                    )

                    # Create submission
                    submission_data = {
                        "submission_type": "online_text_entry",
                        "body": f"<p>Assignment submission for {assignment_name}</p>"
                               f"<p>Student: {target_student_email}</p>"
                               f"<p>Course: {course_name}</p>"
                               f"<p>This is a sample submission demonstrating the assignment submission functionality.</p>"
                               f"<p>Content: I have completed the required tasks as specified in the assignment description.</p>",
                        "submitted_at": submitted_time.isoformat()
                    }

                    submission = self.db.submit_assignment(
                        course_id=int(course_id),
                        assignment_id=int(assignment_id),
                        submission_data=submission_data,
                        user_id=ryan_user_id
                    )

                    submitted_count += 1
                    print(f"      [SUBMITTED] {assignment_name}")

                except Exception as e:
                    print(f"      [ERROR] Failed to submit {assignment_name}: {e}")
                    continue

        # Print summary
        print(f"\n{'='*60}")
        print(f"ASSIGNMENT SUBMISSION SUMMARY")
        print(f"{'='*60}")
        print(f"Student: {target_student_email}")
        print(f"Total assignments: {total_assignments}")
        print(f"Successfully submitted: {submitted_count}")
        print(f"Failed: {total_assignments - submitted_count}")
        print(f"{'='*60}")

        if submitted_count == total_assignments:
            print("[SUCCESS] All assignments submitted successfully for Ryan!")
        elif submitted_count > 0:
            print("[PARTIAL] Some assignments were submitted successfully.")
        else:
            print("[FAIL] No assignments were submitted.")

        return submitted_count > 0

    def update_course_due_dates(self) -> bool:
        """Update due dates in course_config.json"""
        print("\n[DATES] Updating course due dates...")

        try:
            current_time = datetime.now()
            print(f"   Current time: {current_time.strftime('%Y-%m-%d %H:%M:%S')}")

            updated_courses = 0
            random.seed(42)

            for course in self.courses_data.get('courses', []):
                # Generate random due date (7-14 days later)
                base_days = 7
                random_days = random.randint(0, 7)
                random_hours = random.randint(0, 23)

                due_date = current_time + timedelta(days=base_days + random_days, hours=random_hours)
                due_date = due_date.replace(hour=23, minute=59, second=0, microsecond=0)
                due_date_str = due_date.strftime('%Y-%m-%dT%H:%M:%SZ')

                # Update quiz due date
                if 'quiz' in course and course['quiz']:
                    course['quiz']['due_at'] = due_date_str

                # Update assignment due date (1-3 days after quiz)
                if 'assignment' in course and course['assignment']:
                    assignment_days_offset = random.randint(1, 3)
                    assignment_due_date = due_date + timedelta(days=assignment_days_offset)
                    course['assignment']['due_at'] = assignment_due_date.strftime('%Y-%m-%dT%H:%M:%SZ')

                updated_courses += 1

            # Save updated config
            backup_path = self.config_file.with_suffix('.json.backup')
            with open(self.config_file, 'r') as src, open(backup_path, 'w') as dst:
                dst.write(src.read())

            with open(self.config_file, 'w', encoding='utf-8') as f:
                json.dump(self.courses_data, f, indent=2, ensure_ascii=False)

            print(f"[SUCCESS] Updated {updated_courses} course due dates")
            return True

        except Exception as e:
            print(f"[ERROR] Failed to update due dates: {e}")
            return False

    def update_csv_files(self) -> bool:
        """Update quiz and assignment CSV files

        Note: This method regenerates groundtruth CSV files using the UPDATED due dates
        from course_config.json (after update_course_due_dates has been called).
        It applies the same filtering logic as generate_task_config.py (exemptions and submissions).
        """
        print("\n[CSV] Updating Groundtruth CSV files (using updated due dates)...")

        try:
            # Load submission config to know which assignments are already submitted
            submission_config_file = self.task_dir / 'files' / 'submission_config.json'
            submitted_course_codes = set()
            if submission_config_file.exists():
                with open(submission_config_file, 'r', encoding='utf-8') as f:
                    submission_config = json.load(f)
                submitted_course_codes = set(submission_config.keys())

            # Load memory.json to know which courses Ryan is exempt from
            memory_file = self.task_dir / 'initial_workspace' / 'memory' / 'memory.json'
            exempted_course_codes = set()
            if memory_file.exists():
                with open(memory_file, 'r', encoding='utf-8') as f:
                    memory_data = json.load(f)
                # Find courses where Ryan is qualified for exemption
                for observation in memory_data.get('observations', []):
                    if 'has been met' in observation and 'qualify for course exemption' in observation:
                        # Extract course code from observation
                        import re
                        match = re.search(r'for ([A-Z]+\d+-\d+)', observation)
                        if match:
                            exempted_course_codes.add(match.group(1))
            else:
                print(f"   [WARN] Memory file does not exist: {memory_file}")

            print(f"   Filter conditions: Exempt courses={len(exempted_course_codes)}, Submitted assignments={len(submitted_course_codes)}")

            # Generate quiz and assignment data from updated course_config.json
            quiz_data = []
            assignment_data = []

            for course in self.courses_data.get('courses', []):
                course_code = course['course_code']
                course_name = course['name']
                credits = course.get('credits', 3)

                # Skip exempt courses
                if course_code in exempted_course_codes:
                    continue

                # Process Quiz
                if 'quiz' in course:
                    quiz = course['quiz']
                    quiz_data.append({
                        'course_code': course_code,
                        'course_name': course_name,
                        'credits': credits,
                        'quiz_title': quiz.get('title', 'Quiz'),
                        'number_of_questions': len(quiz.get('questions', [])),
                        'time_limit': quiz.get('time_limit', 60),
                        'allowed_attempts': quiz.get('allowed_attempts', 1),
                        'scoring_policy': quiz.get('scoring_policy', 'keep_highest'),
                        'points_possible': quiz.get('points_possible', 100),
                        'deadline': quiz.get('due_at', '')
                    })

                # Process Assignment (skip submitted ones)
                if 'assignment' in course and course_code not in submitted_course_codes:
                    assignment = course['assignment']
                    assignment_data.append({
                        'course_code': course_code,
                        'assignment_title': assignment.get('name', 'Assignment'),
                        'description': assignment.get('description', ''),
                        'deadline': assignment.get('due_at', ''),
                        'course_name': course_name,
                        'points_possible': assignment.get('points_possible', 100)
                    })

            # Sort by deadline and course_code (same logic as generate_task_config.py)
            from datetime import datetime

            def sort_key(item):
                try:
                    deadline = datetime.fromisoformat(item['deadline'].replace('Z', '+00:00'))
                except:
                    deadline = datetime.max
                return (deadline, item['course_code'])

            quiz_data.sort(key=sort_key)
            assignment_data.sort(key=sort_key)

            # Save to CSV files in both locations
            import csv
            import shutil

            # Define paths
            groundtruth_path = self.task_dir / 'groundtruth_workspace'
            groundtruth_path.mkdir(parents=True, exist_ok=True)

            # Save to groundtruth_workspace
            groundtruth_quiz_csv = groundtruth_path / 'quiz_info.csv'
            groundtruth_assignment_csv = groundtruth_path / 'assignment_info.csv'

            # Save quiz_info.csv (always write header, even if no data)
            with open(groundtruth_quiz_csv, 'w', encoding='utf-8', newline='') as f:
                fieldnames = ['course_code', 'course_name', 'credits', 'quiz_title',
                            'number_of_questions', 'time_limit', 'allowed_attempts',
                            'scoring_policy', 'points_possible', 'deadline']
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                if quiz_data:
                    writer.writerows(quiz_data)
                f.write('\n')

            # Save assignment_info.csv (always write header, even if no data)
            with open(groundtruth_assignment_csv, 'w', encoding='utf-8', newline='') as f:
                fieldnames = ['course_code', 'assignment_title', 'description',
                            'deadline', 'course_name', 'points_possible']
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                if assignment_data:
                    writer.writerows(assignment_data)
                f.write('\n')

            print(f"   [SUCCESS] Quiz CSV: {len(quiz_data)} records")
            print(f"   [SUCCESS] Assignment CSV: {len(assignment_data)} records")
            print(f"   Groundtruth CSV updated (using latest due dates)")

            # Also copy to agent_workspace if provided
            if self.agent_workspace:
                agent_workspace_path = Path(self.agent_workspace)
                try:
                    # Create agent_workspace if it doesn't exist
                    if not agent_workspace_path.exists():
                        agent_workspace_path.mkdir(parents=True, exist_ok=True)
                        print(f"   Created agent_workspace directory: {agent_workspace_path}")

                    # Copy CSV files
                    # shutil.copy2(groundtruth_quiz_csv, agent_workspace_path / 'quiz_info.csv')
                    # shutil.copy2(groundtruth_assignment_csv, agent_workspace_path / 'assignment_info.csv')
                    # print(f"   CSV files copied to agent_workspace")

                    # Also copy memory directory if it exists
                    memory_src = self.task_dir / 'initial_workspace' / 'memory'
                    memory_dst = agent_workspace_path / 'memory'
                    if memory_src.exists():
                        # Copy to memory_dst (original location)
                        if memory_dst.exists():
                            nfs_safe_rmtree(memory_dst)
                        shutil.copytree(memory_src, memory_dst)
                        print(f"   Memory folder copied to agent_workspace")

                        # Also copy to memory_dst/memories for memory_tool access
                        target_memories = memory_dst / 'memories'
                        target_memories.mkdir(parents=True, exist_ok=True)
                        for item in memory_src.iterdir():
                            if item.is_file():
                                shutil.copy2(item, target_memories / item.name)
                            elif item.is_dir():
                                target_subdir = target_memories / item.name
                                if target_subdir.exists():
                                    nfs_safe_rmtree(target_subdir)
                                shutil.copytree(item, target_subdir)
                        print(f"   Memory files copied to {target_memories} for memory_tool access")
                except Exception as e:
                    print(f"   [WARN] Unable to copy to agent_workspace: {e}")

            return True

        except Exception as e:
            print(f"   [ERROR] CSV update failed: {e}")
            import traceback
            traceback.print_exc()
            return False  # Not an error, just a warning


def run_with_args(delete=False, publish=False, submit_assignments=False, agent_workspace=None, task_dir=None):
    """
    Main function compatible with original interface

    Args:
        delete: If True, clear database
        publish: Ignored (courses are always published)
        submit_assignments: If True, submit assignments for students
        agent_workspace: Path to agent workspace
        task_dir: Path to task directory (overrides config file locations)
    """
    setup = SimplifiedCanvasSetup(agent_workspace=agent_workspace, task_dir=task_dir)

    if delete:
        print("[DELETE] Deleting all courses (clearing database)...")
        return setup.clear_database()

    if submit_assignments:
        print("[SUBMIT] Submitting student assignments...")
        if not setup.load_data():
            return False
        return setup.submit_student_assignments()

    # Default: create courses
    print("[CREATE] Creating courses with local database...")

    if not setup.load_data():
        return False

    if not setup.clear_database():
        return False

    if not setup.update_course_due_dates():
        return False

    if not setup.update_csv_files():
        return False

    # Reload data after updating due dates
    if not setup.load_data():
        return False

    if not setup.create_courses():
        return False

    if not setup.enroll_students():
        return False

    print("\n[SUCCESS] Course setup completed successfully!")

    # Set environment variable
    data_dir = setup.db.data_dir
    os.environ['CANVAS_DATA_DIR'] = data_dir

    print(f"\n[ENV] Environment Variable Set:")
    print(f"   CANVAS_DATA_DIR={data_dir}")

    # Write to environment file
    env_file = Path(data_dir).parent / ".canvas_env"
    try:
        with open(env_file, 'w') as f:
            f.write(f"# Canvas Simplified Environment Variables\n")
            f.write(f"# Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"export CANVAS_DATA_DIR={data_dir}\n")
        print(f"[FILE] Environment file created: {env_file}")
    except Exception as e:
        print(f"[WARN] Could not create environment file: {e}")

    return True


if __name__ == "__main__":
    parser = ArgumentParser()
    parser.add_argument("--agent_workspace", required=False)
    parser.add_argument("--delete", action="store_true", help="Delete all courses")
    parser.add_argument("--publish", action="store_true", help="Publish courses (ignored)")
    parser.add_argument("--submit-assignments", action="store_true", dest="submit_assignments",
                       help="Submit assignments for students")
    parser.add_argument("--launch_time", required=False, help="Launch time")
    args = parser.parse_args()

    # Call synchronous function directly, no asyncio needed
    success = run_with_args(
        delete=args.delete,
        publish=args.publish,
        submit_assignments=args.submit_assignments,
        agent_workspace=args.agent_workspace
    )

    sys.exit(0 if success else 1)
