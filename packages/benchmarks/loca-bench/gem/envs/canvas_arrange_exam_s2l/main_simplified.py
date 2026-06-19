#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Canvas Course Setup - Simplified Version using Local Database
Directly operate on local JSON database instead of using Canvas API
"""

import sys
import os
import json
import random
import re
from pathlib import Path
from argparse import ArgumentParser
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Any, Optional

# Set random seed for reproducibility
random.seed(42)

# Add mcp_convert path to import the database utilities
from mcp_convert.mcps.canvas.database_utils import CanvasDatabase



class SimplifiedCanvasSetup:
    """Setup Canvas courses using local JSON database"""
    
    def __init__(self, data_dir: str = None, agent_workspace: str = None, task_dir: str = None):
        """
        Initialize the setup
        
        Args:
            data_dir: Path to Canvas data directory
            agent_workspace: Path to agent workspace (for local_db location)
            task_dir: Path to task directory (for config files)
        """
        if data_dir is None:
            if agent_workspace:
                workspace_parent = Path(agent_workspace).parent
                data_dir = str(workspace_parent / "local_db" / "canvas")
                print(f"📂 Using local database directory: {data_dir}")
            else:
                data_dir = str(Path(__file__).parent.parent / "local_db" / "canvas")
                print(f"⚠️  No agent_workspace provided, using fallback: {data_dir}")
        
        # Create data directory if it doesn't exist
        Path(data_dir).mkdir(parents=True, exist_ok=True)
        
        self.db = CanvasDatabase(data_dir=data_dir)
        
        # Determine task_dir for config files
        if task_dir is None:
            if agent_workspace:
                task_dir = str(Path(agent_workspace).parent)
            else:
                task_dir = str(current_dir.parent)
        
        self.config_file = Path(task_dir) / 'files' / 'course_config.json'
        self.users_file = Path(task_dir) / 'files' / 'canvas_users.json'
        self.courses_data = None
        self.users_data = None
        self.account_id = 1  # Default account
        
    def load_data(self) -> bool:
        """Load course and user data from JSON files"""
        try:
            print("📚 Loading configuration files...")
            
            # Load course config
            with open(self.config_file, 'r', encoding='utf-8') as f:
                self.courses_data = json.load(f)
            print(f"   ✓ Loaded {len(self.courses_data.get('courses', []))} courses from config")
            
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
            
            print(f"   ✓ Loaded {len(self.users_data.get('users', []))} users")
            
            return True
            
        except FileNotFoundError as e:
            print(f"❌ Configuration file not found: {e}")
            return False
        except json.JSONDecodeError as e:
            print(f"❌ Invalid JSON format: {e}")
            return False
    
    def clear_database(self) -> bool:
        """Clear all data from the database"""
        print("\n🗑️  Clearing database...")
        
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
            
            print(f"✅ Database cleared successfully")
            return True
            
        except Exception as e:
            print(f"❌ Failed to clear database: {e}")
            return False
    
    def get_user_name_from_config(self, email: str) -> Optional[str]:
        """Get user's full name from users configuration by email"""
        if not self.users_data or 'users' not in self.users_data:
            return None
        
        for user in self.users_data['users']:
            if user.get('email') == email:
                return user.get('full_name') or user.get('name')
        
        return None
    
    def get_name_from_email(self, email: str) -> str:
        """Extract a simple name from email address
        
        Examples:
            debra_flores76@mcp.com -> Debra
            steven.hernandez@mcp.com -> Steven
        """
        # Get the part before @
        username = email.split('@')[0]
        
        # Split by underscore or dot and take the first part
        if '_' in username:
            name = username.split('_')[0]
        elif '.' in username:
            name = username.split('.')[0]
        else:
            name = username
        
        # Remove digits from the end
        name = re.sub(r'\d+$', '', name)
        
        # Capitalize first letter
        return name.capitalize()
    
    
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
            print(f"   ❌ Failed to create user {name}: {e}")
            return None
    
    def generate_additional_announcements(self, course_config: Dict) -> List[Dict[str, str]]:
        """Generate additional realistic announcements for a course"""
        course_name = course_config.get("name", "Course")
        course_code = course_config.get("course_code", "COURSE")

        announcements = []

        # 1. Course welcome announcement
        exam_type = course_config.get("exam_type", "TBD")
        if exam_type == "no_exam":
            exam_type_display = "No Final Exam"
        else:
            exam_type_display = exam_type.replace("_", " ").title()
        
        credits = course_config.get("credits", "TBD")
        
        announcements.append({
            "title": f"Welcome to {course_code}!",
            "content": f"Dear {course_code} students,\n\nWelcome to {course_name}! I'm excited to have you in this course.\n\n🏫 Course Information:\n🎓 Credits: {credits}\n📝 Exam Type: {exam_type_display}\n\n📚 Course Materials:\n- Please check the syllabus for required textbooks\n- All lecture slides will be posted on Canvas\n- Office hours: Tuesdays and Thursdays 2:00-4:00 PM\n\n💡 Important Notes:\n- Please introduce yourself in the discussion forum\n- Check your email regularly for course updates\n- Don't hesitate to ask questions!\n\nLooking forward to a great semester!\n\nBest regards,\nCourse Instructor"
        })
        
        # 2. First assignment announcement
        if "CS" in course_code or "AI" in course_code or "NET" in course_code or "DB" in course_code:
            announcements.append({
                "title": f"Assignment 1 Released - {course_code}",
                "content": f"Dear {course_code} students,\n\n📝 Assignment 1 has been released and is now available under the Assignments tab.\n\n📅 Due Date: October 15, 2024, 11:59 PM\n📊 Weight: 15% of final grade\n⏱️ Estimated Time: 8-10 hours\n\n📋 Assignment Details:\n- Programming assignment focusing on fundamental concepts\n- Submit your code files (.py, .java, or .cpp)\n- Include a README file with instructions\n- Follow the coding style guidelines\n\n💻 Submission:\n- Upload files to Canvas before the deadline\n- Late submissions: -10% per day\n\nGood luck!\n\nBest regards,\nCourse Instructor"
            })
        elif "MATH" in course_code:
            announcements.append({
                "title": f"Problem Set 1 Released - {course_code}",
                "content": f"Dear {course_code} students,\n\n📝 Problem Set 1 has been posted and is available under Assignments.\n\n📅 Due Date: October 12, 2024, 11:59 PM\n📊 Weight: 12% of final grade\n⏱️ Estimated Time: 6-8 hours\n\n📋 Assignment Details:\n- 8 problems covering chapters 1-3\n- Show all work for full credit\n- Handwritten solutions are acceptable\n- Scan and upload as PDF if handwritten\n\n💡 Tips:\n- Start early - some problems are challenging\n- Attend office hours if you need help\n- Form study groups (but submit individual work)\n\nBest regards,\nCourse Instructor"
            })
        elif "ENG" in course_code:
            announcements.append({
                "title": f"Essay Assignment 1 - {course_code}",
                "content": f"Dear {course_code} students,\n\n📝 Your first essay assignment is now available.\n\n📅 Due Date: October 18, 2024, 11:59 PM\n📊 Weight: 20% of final grade\n📄 Length: 1000-1200 words\n\n📋 Assignment Details:\n- Topic: 'The Impact of Technology on Modern Communication'\n- Use MLA format\n- Minimum 5 academic sources required\n- Submit as PDF or Word document\n\n✍️ Requirements:\n- Clear thesis statement\n- Well-structured arguments\n- Proper citations and bibliography\n- Proofread for grammar and style\n\nBest regards,\nCourse Instructor"
            })
        
        # 3. Midterm exam or quiz announcement
        if course_config.get("exam_type") != "no_exam":
            announcements.append({
                "title": f"Midterm Exam Information - {course_code}",
                "content": f"Dear {course_code} students,\n\n📅 Midterm Exam Schedule:\n\n📅 Date: November 12, 2024\n⏰ Time: Regular class time\n⏱️ Duration: 75 minutes\n📍 Location: Regular classroom\n\n📚 Exam Coverage:\n- Chapters 1-6 from textbook\n- All lecture materials through Week 8\n- Homework assignments 1-4\n\n📝 Format:\n- Multiple choice (40%)\n- Short answer questions (35%)\n- Problem solving (25%)\n\n💡 Study Tips:\n- Review lecture slides and notes\n- Practice problems from homework\n- Attend review session on November 10\n\nGood luck with your preparation!\n\nBest regards,\nCourse Instructor"
            })
        
        # 4. Project announcement (for programming courses)
        if "CS" in course_code or "AI" in course_code or "NET" in course_code or "DB" in course_code:
            announcements.append({
                "title": f"Group Project Announcement - {course_code}",
                "content": f"Dear {course_code} students,\n\n🚀 Group Project has been announced!\n\n👥 Team Size: 3-4 students\n📅 Project Due: December 15, 2024\n📊 Weight: 25% of final grade\n\n🎯 Project Options:\n1. Web application development\n2. Data analysis and visualization\n3. Machine learning implementation\n4. Mobile app development\n\n📋 Deliverables:\n- Source code with documentation\n- Technical report (10-15 pages)\n- 15-minute presentation\n- Demo video (5 minutes)\n\n📅 Important Dates:\n- Team formation: November 20, 2024\n- Project proposal: November 25, 2024\n- Progress report: December 5, 2024\n- Final submission: December 15, 2024\n- Presentations: December 16-18, 2024\n\nStart forming your teams!\n\nBest regards,\nCourse Instructor"
            })
        elif "MATH" in course_code:
            announcements.append({
                "title": f"Research Project - {course_code}",
                "content": f"Dear {course_code} students,\n\n📊 Individual Research Project Announced!\n\n📅 Due Date: December 12, 2024\n📊 Weight: 20% of final grade\n\n🎯 Project Requirements:\n- Choose a mathematical topic related to course material\n- Write a 8-10 page research paper\n- Include mathematical proofs or applications\n- Present findings to the class (10 minutes)\n\n📋 Suggested Topics:\n- Applications of linear algebra in computer graphics\n- Mathematical modeling in real-world problems\n- Historical development of key theorems\n- Computational methods and algorithms\n\n📅 Timeline:\n- Topic selection: November 15, 2024\n- Outline submission: November 25, 2024\n- Draft for peer review: December 5, 2024\n- Final submission: December 12, 2024\n\nBest regards,\nCourse Instructor"
            })
        
        return announcements
    
    def create_announcement_for_course(self, course_id: int, announcement_config: Dict, credits: int = None, exam_type: str = None) -> Optional[int]:
        """Create an announcement for a course"""
        try:
            announcement_data = {
                "title": announcement_config.get("title", "Announcement"),
                "content": announcement_config.get("content", ""),
                "credits": credits,
                "exam_type": exam_type
            }
            
            announcement = self.db.create_announcement(course_id, announcement_data)
            return announcement['id']
            
        except Exception as e:
            print(f"   ❌ Failed to create announcement: {e}")
            return None
    
    def create_multiple_announcements(self, course_id: int, course_config: Dict) -> int:
        """Create multiple announcements in chronological order"""
        success_count = 0

        try:
            credits = course_config.get('credits')
            exam_type = course_config.get('exam_type')

            # 1. Create early semester announcements (Sep-Dec, in chronological order)
            additional_announcements = self.generate_additional_announcements(course_config)
            print(f"      📝 Creating {len(additional_announcements)} semester announcements (Sep-Dec 2024)")

            for i, announcement in enumerate(additional_announcements, 1):
                announcement_id = self.create_announcement_for_course(course_id, announcement, credits, exam_type)
                if announcement_id:
                    success_count += 1

            # 2. Finally create final exam announcement (Jan 2025)
            if 'announcement' in course_config and course_config['announcement']:
                print(f"      📢 Creating final exam announcement (Jan 2025)")
                announcement_id = self.create_announcement_for_course(
                    course_id,
                    course_config['announcement'],
                    credits,
                    exam_type
                )
                if announcement_id:
                    success_count += 1
            
            print(f"      ✓ Created {success_count} announcements")
            return success_count
            
        except Exception as e:
            print(f"   ❌ Failed to create announcements: {e}")
            return success_count
    
    def create_courses(self) -> bool:
        """Create all courses from configuration"""
        print("\n📚 Creating courses...")
        
        if not self.courses_data or 'courses' not in self.courses_data:
            print("❌ No courses data loaded")
            return False
        
        courses = self.courses_data['courses']
        created_count = 0
        
        for course_config in courses:
            try:
                course_name = course_config.get('name', 'Untitled Course')
                course_code = course_config.get('course_code', 'UNKNOWN')
                
                print(f"\n   📖 Creating course: {course_code} - {course_name}")
                
                # Get teacher information first
                teacher_email = course_config.get('teacher', 'teacher@example.com')
                teacher_password = course_config.get('teacher_password', 'teacher_password_123')
                
                # Get teacher's name from email prefix (e.g., debra_flores76@mcp.com -> Debra)
                teacher_name = self.get_name_from_email(teacher_email)
                
                # Create course with teacher information
                course = self.db.create_course(
                    account_id=self.account_id,
                    course_data={
                        "name": course_name,
                        "course_code": course_code,
                        "workflow_state": "available",  # Published by default
                        "is_public": True,
                        "is_public_to_auth_users": True,
                        "teacher_name": teacher_name,
                        "teacher_email": teacher_email
                    }
                )
                course_id = course['id']
                print(f"      ✓ Course created (ID: {course_id})")
                
                # Add teacher
                teacher_id = self.find_or_create_user(teacher_name, teacher_email, teacher_password)
                if teacher_id:
                    self.db.enroll_user(course_id, teacher_id, "TeacherEnrollment", "active")
                    print(f"      ✓ Teacher enrolled: {teacher_name} ({teacher_email})")
                
                # Create multiple announcements (semester announcements + final exam announcement)
                announcement_count = self.create_multiple_announcements(course_id, course_config)
                
                # Enroll students for this specific course
                students = course_config.get('students', [])
                for student_email in students:
                    try:
                        # Get student's real name from users configuration
                        student_name = self.get_user_name_from_config(student_email)
                        if not student_name:
                            student_name = f"Student {student_email}"
                        
                        student_id = self.find_or_create_user(student_name, student_email, "student_password_123")
                        if student_id:
                            self.db.enroll_user(course_id, student_id, "StudentEnrollment", "active")
                    except Exception as e:
                        print(f"      ❌ Failed to enroll student {student_email}: {e}")
                        continue
                
                print(f"      ✓ Enrolled {len(students)} students")
                
                created_count += 1
                
            except Exception as e:
                print(f"   ❌ Failed to create course {course_config.get('course_code', 'UNKNOWN')}: {e}")
                continue
        
        print(f"\n✅ Created {created_count}/{len(courses)} courses")
        return created_count > 0


async def run_with_args(delete=False, publish=False, agent_workspace=None, task_dir=None):
    """
    Main function compatible with original interface
    
    Args:
        delete: If True, clear database
        publish: Ignored (courses are always published)
        agent_workspace: Path to agent workspace
        task_dir: Path to task directory
    """
    setup = SimplifiedCanvasSetup(agent_workspace=agent_workspace, task_dir=task_dir)
    
    if delete:
        print("🗑️  Deleting all courses (clearing database)...")
        return setup.clear_database()
    
    # Default: create courses
    print("🚀 Creating courses with local database...")
    
    if not setup.load_data():
        return False
    
    if not setup.clear_database():
        return False
    
    if not setup.create_courses():
        return False
    
    print("\n✅ Course setup completed successfully!")
    
    # Set environment variable
    data_dir = setup.db.data_dir
    os.environ['CANVAS_DATA_DIR'] = data_dir
    
    print(f"\n📌 Environment Variable Set:")
    print(f"   CANVAS_DATA_DIR={data_dir}")
    
    # Write to environment file
    env_file = Path(data_dir).parent / ".canvas_env"
    try:
        with open(env_file, 'w') as f:
            f.write(f"# Canvas Simplified Environment Variables\n")
            f.write(f"# Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"export CANVAS_DATA_DIR={data_dir}\n")
        print(f"📄 Environment file created: {env_file}")
    except Exception as e:
        print(f"⚠️  Could not create environment file: {e}")
    
    return True


# Add current directory to Python path
current_dir = Path(__file__).parent
sys.path.insert(0, str(current_dir))


if __name__ == "__main__":
    parser = ArgumentParser()
    parser.add_argument("--agent_workspace", required=False)
    parser.add_argument("--delete", action="store_true", help="Delete all courses")
    parser.add_argument("--publish", action="store_true", help="Publish courses (ignored)")
    parser.add_argument("--launch_time", required=False, help="Launch time")
    args = parser.parse_args()
    
    import asyncio
    success = asyncio.run(run_with_args(
        delete=args.delete,
        publish=args.publish,
        agent_workspace=args.agent_workspace
    ))
    
    sys.exit(0 if success else 1)
