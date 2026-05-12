"""
Canvas Database Utilities

Manages local JSON data files for the simplified Canvas MCP server.
"""

import json
import os
from typing import Dict, List, Optional, Any
from datetime import datetime, timezone


class CanvasDatabase:
    """Canvas database implementation using local JSON files"""

    def __init__(self, data_dir: str = None):
        if data_dir is None:
            data_dir = os.path.join(os.path.dirname(__file__), "data")
        self.data_dir = data_dir
        self.current_user_id = None  # No user logged in by default
        self.authenticated = False

        # Load all data files
        self._load_data()
    
    def _load_data(self):
        """Load all JSON data files"""
        self.users = self._load_json_file("users.json")
        self.courses = self._load_json_file("courses.json")
        self.assignments = self._load_json_file("assignments.json")
        self.enrollments = self._load_json_file("enrollments.json")
        self.submissions = self._load_json_file("submissions.json")
        self.files = self._load_json_file("files.json")
        self.folders = self._load_json_file("folders.json")
        self.pages = self._load_json_file("pages.json")
        self.modules = self._load_json_file("modules.json")
        self.module_items = self._load_json_file("module_items.json")
        self.discussions = self._load_json_file("discussions.json")
        self.announcements = self._load_json_file("announcements.json")
        self.quizzes = self._load_json_file("quizzes.json")
        self.rubrics = self._load_json_file("rubrics.json")
        self.conversations = self._load_json_file("conversations.json")
        self.notifications = self._load_json_file("notifications.json")
        self.calendar_events = self._load_json_file("calendar_events.json")
        self.accounts = self._load_json_file("accounts.json")
        self.grades = self._load_json_file("grades.json")
    
    def _load_json_file(self, filename: str) -> dict:
        """Load a JSON file from the data directory"""
        filepath = os.path.join(self.data_dir, filename)
        try:
            with open(filepath, 'r') as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}
    
    def _save_json_file(self, filename: str, data: dict):
        """Save data to a JSON file"""
        filepath = os.path.join(self.data_dir, filename)
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)
    
    def set_current_user(self, user_id: int):
        """Set the current user context"""
        self.current_user_id = user_id

    # Authentication methods
    def login(self, login_id: str, password: str) -> Dict:
        """Login a user"""
        # Find user by login_id
        for user_id, user in self.users.items():
            if user.get("login_id") == login_id:
                # Check password
                if user.get("password") == password:
                    self.current_user_id = user["id"]
                    self.authenticated = True
                    return {
                        "id": user["id"],
                        "name": user["name"],
                        "email": user.get("primary_email", user.get("login_id")),
                        "login_id": user["login_id"],
                        "logged_in": True,
                        "message": f"Successfully logged in as {user['name']}"
                    }

        raise ValueError("Invalid login_id or password")

    def logout(self) -> Dict:
        """Logout the current user"""
        if not self.authenticated:
            return {"message": "No user is currently logged in", "logged_in": False}

        user_name = self.get_user_profile()["name"] if self.current_user_id else "Unknown"
        self.current_user_id = None
        self.authenticated = False

        return {
            "message": f"Successfully logged out {user_name}",
            "logged_in": False
        }

    def get_current_user(self) -> Dict:
        """Get current logged in user"""
        if not self.authenticated or not self.current_user_id:
            return {
                "logged_in": False,
                "message": "No user is currently logged in"
            }

        user = self.get_user_profile()
        return {
            "id": user["id"],
            "name": user["name"],
            "email": user.get("primary_email", user.get("login_id")),
            "login_id": user["login_id"],
            "logged_in": True
        }

    def list_users(self) -> Dict:
        """List all users (for demo purposes)"""
        users_list = []
        for user in self.users.values():
            users_list.append({
                "id": user["id"],
                "name": user["name"],
                "login_id": user.get("login_id"),
                "email": user.get("primary_email", user.get("login_id"))
            })
        return {"users": users_list, "count": len(users_list)}

    def _check_authentication(self):
        """Check if user is authenticated"""
        if not self.authenticated:
            raise ValueError("User must be logged in to perform this action")

    # User methods
    def get_user_profile(self, user_id: int = None) -> Optional[Dict]:
        """Get user profile"""
        if user_id is None:
            user_id = self.current_user_id
        return self.users.get(str(user_id))
    
    def update_user_profile(self, user_id: int, updates: Dict) -> Optional[Dict]:
        """Update user profile"""
        if str(user_id) not in self.users:
            return None
        
        self.users[str(user_id)].update(updates)
        self.users[str(user_id)]["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._save_json_file("users.json", self.users)
        
        return self.users[str(user_id)]
    
    # Course methods
    def list_courses(self, user_id: int = None, include_ended: bool = False) -> List[Dict]:
        """List courses for a user"""
        if user_id is None:
            user_id = self.current_user_id
        
        enrolled_courses = []
        
        # Find courses where user is enrolled
        for course_key, course_enrollments in self.enrollments.items():
            if str(user_id) in course_enrollments:
                enrollment = course_enrollments[str(user_id)]
                if enrollment["enrollment_state"] == "active":
                    course_id = enrollment["course_id"]
                    course = self.courses.get(str(course_id))
                    if course:
                        if include_ended or course.get("workflow_state") == "available":
                            enrolled_courses.append(course)
        
        return enrolled_courses
    
    def get_course(self, course_id: int) -> Optional[Dict]:
        """Get course details"""
        return self.courses.get(str(course_id))
    
    def create_course(self, account_id: int, course_data: Dict) -> Dict:
        """Create a new course"""
        # Generate new course ID
        new_id = max([int(k) for k in self.courses.keys()], default=0) + 1
        
        course = {
            "id": new_id,
            "account_id": account_id,
            "uuid": f"course-uuid-{new_id}",
            "start_at": None,
            "conclude_at": None,
            "grading_standard_id": None,
            "is_public": False,
            "allow_student_forum_attachments": False,
            "default_view": "modules",
            "root_account_id": account_id,
            "enrollment_term_id": 1,
            "open_enrollment": False,
            "allow_wiki_comments": False,
            "self_enrollment": False,
            "license": None,
            "restrict_enrollments_to_course_dates": False,
            "end_at": None,
            "public_syllabus": False,
            "public_syllabus_to_auth": False,
            "storage_quota_mb": 500,
            "is_public_to_auth_users": False,
            "hide_final_grades": False,
            "apply_assignment_group_weights": False,
            "calendar": {
                "ics": f"http://localhost:10001/feeds/calendars/course_{new_id}.ics"
            },
            "time_zone": "America/Denver",
            "sis_course_id": None,
            "integration_id": None,
            "workflow_state": "unpublished"
        }
        
        # Update with provided data
        course.update(course_data)
        
        # Save to database
        self.courses[str(new_id)] = course
        self._save_json_file("courses.json", self.courses)
        
        return course
    
    def update_course(self, course_id: int, updates: Dict) -> Optional[Dict]:
        """Update course"""
        if str(course_id) not in self.courses:
            return None
        
        self.courses[str(course_id)].update(updates)
        self._save_json_file("courses.json", self.courses)
        
        return self.courses[str(course_id)]
    
    # Assignment methods
    def list_assignments(self, course_id: int) -> List[Dict]:
        """List assignments for a course"""
        assignments = []
        for assignment in self.assignments.values():
            if assignment.get("course_id") == course_id:
                assignments.append(assignment)
        return assignments
    
    def get_assignment(self, course_id: int, assignment_id: int) -> Optional[Dict]:
        """Get assignment details"""
        assignment = self.assignments.get(str(assignment_id))
        if assignment and assignment.get("course_id") == course_id:
            return assignment
        return None
    
    def create_assignment(self, course_id: int, assignment_data: Dict) -> Dict:
        """Create a new assignment"""
        # Generate new assignment ID
        new_id = max([int(k) for k in self.assignments.keys()], default=0) + 1
        
        assignment = {
            "id": new_id,
            "course_id": course_id,
            "description": "",
            "due_at": None,
            "unlock_at": None,
            "lock_at": None,
            "points_possible": 0,
            "grading_type": "points",
            "assignment_group_id": 1,
            "grading_standard_id": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "peer_reviews": False,
            "automatic_peer_reviews": False,
            "position": 1,
            "grade_group_students_individually": False,
            "anonymous_peer_reviews": False,
            "group_category_id": None,
            "post_to_sis": False,
            "moderated_grading": False,
            "omit_from_final_grade": False,
            "intra_group_peer_reviews": False,
            "anonymous_instructor_annotations": False,
            "submission_types": ["none"],
            "has_submitted_submissions": False,
            "due_date_required": False,
            "max_name_length": 255,
            "in_closed_grading_period": False,
            "is_quiz_assignment": False,
            "muted": False,
            "html_url": f"http://localhost:10001/courses/{course_id}/assignments/{new_id}",
            "has_overrides": False,
            "needs_grading_count": 0,
            "integration_id": None,
            "integration_data": {},
            "published": False,
            "unpublishable": True,
            "only_visible_to_overrides": False,
            "locked_for_user": False,
            "submissions_download_url": f"http://localhost:10001/courses/{course_id}/assignments/{new_id}/submissions?zip=1"
        }
        
        # Update with provided data
        assignment.update(assignment_data)
        
        # Save to database
        self.assignments[str(new_id)] = assignment
        self._save_json_file("assignments.json", self.assignments)
        
        return assignment
    
    def update_assignment(self, course_id: int, assignment_id: int, updates: Dict) -> Optional[Dict]:
        """Update assignment"""
        assignment = self.assignments.get(str(assignment_id))
        if not assignment or assignment.get("course_id") != course_id:
            return None
        
        assignment.update(updates)
        assignment["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._save_json_file("assignments.json", self.assignments)
        
        return assignment
    
    # Submission methods
    def get_submission(self, course_id: int, assignment_id: int, user_id: int = None) -> Optional[Dict]:
        """Get submission for an assignment"""
        if user_id is None:
            user_id = self.current_user_id
        
        assignment_key = f"assignment_{assignment_id}"
        if assignment_key in self.submissions:
            return self.submissions[assignment_key].get(str(user_id))
        return None
    
    def submit_assignment(self, course_id: int, assignment_id: int, submission_data: Dict, user_id: int = None) -> Dict:
        """Submit an assignment"""
        if user_id is None:
            user_id = self.current_user_id
        
        assignment_key = f"assignment_{assignment_id}"
        
        # Initialize assignment submissions if not exists
        if assignment_key not in self.submissions:
            self.submissions[assignment_key] = {}
        
        # Generate new submission ID
        all_submission_ids = []
        for assignment_subs in self.submissions.values():
            for sub in assignment_subs.values():
                if isinstance(sub, dict) and "id" in sub:
                    all_submission_ids.append(sub["id"])
        new_id = max(all_submission_ids, default=0) + 1
        
        submission = {
            "id": new_id,
            "assignment_id": assignment_id,
            "user_id": user_id,
            "submission_type": submission_data.get("submission_type", "online_text_entry"),
            "body": submission_data.get("body"),
            "url": submission_data.get("url"),
            "grade": None,
            "score": None,
            "submitted_at": datetime.now(timezone.utc).isoformat(),
            "graded_at": None,
            "grader_id": None,
            "attempt": 1,
            "workflow_state": "submitted",
            "grade_matches_current_submission": True,
            "published_grade": None,
            "published_score": None,
            "grading_period_id": None,
            "preview_url": f"http://localhost:10001/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}?preview=1",
            "late": False,
            "missing": False,
            "entered_grade": None,
            "entered_score": None
        }
        
        # Add file attachments if provided
        if submission_data.get("file_ids"):
            submission["attachments"] = [
                {
                    "id": file_id,
                    "uuid": f"file-uuid-{file_id}",
                    "display_name": f"file_{file_id}",
                    "filename": f"file_{file_id}",
                    "url": f"http://localhost:10001/files/{file_id}/download"
                }
                for file_id in submission_data["file_ids"]
            ]
        
        # Save submission
        self.submissions[assignment_key][str(user_id)] = submission
        self._save_json_file("submissions.json", self.submissions)
        
        return submission
    
    def submit_grade(self, course_id: int, assignment_id: int, user_id: int, grade: Any, comment: str = None, grader_id: int = None) -> Optional[Dict]:
        """Submit a grade for a student's assignment"""
        if grader_id is None:
            grader_id = self.current_user_id
        
        assignment_key = f"assignment_{assignment_id}"
        
        if assignment_key not in self.submissions or str(user_id) not in self.submissions[assignment_key]:
            return None
        
        submission = self.submissions[assignment_key][str(user_id)]
        
        # Update grade information
        submission.update({
            "grade": str(grade) if grade is not None else None,
            "score": float(grade) if isinstance(grade, (int, float)) else None,
            "graded_at": datetime.now(timezone.utc).isoformat(),
            "grader_id": grader_id,
            "published_grade": str(grade) if grade is not None else None,
            "published_score": float(grade) if isinstance(grade, (int, float)) else None,
            "entered_grade": str(grade) if grade is not None else None,
            "entered_score": float(grade) if isinstance(grade, (int, float)) else None,
            "workflow_state": "graded"
        })
        
        if comment:
            submission["comment"] = comment
        
        self._save_json_file("submissions.json", self.submissions)
        
        return submission
    
    # Files & Folders methods
    def list_files(self, course_id: int, folder_id: int = None) -> List[Dict]:
        """List files in a course or folder"""
        files = []
        for file_data in self.files.values():
            if file_data.get("course_id") == course_id:
                if folder_id is None or file_data.get("folder_id") == folder_id:
                    files.append(file_data)
        return files
    
    def get_file(self, file_id: int) -> Optional[Dict]:
        """Get file information"""
        return self.files.get(str(file_id))
    
    def list_folders(self, course_id: int) -> List[Dict]:
        """List folders in a course"""
        folders = []
        for folder in self.folders.values():
            if folder.get("context_id") == course_id and folder.get("context_type") == "Course":
                folders.append(folder)
        return folders
    
    # Pages methods
    def list_pages(self, course_id: int) -> List[Dict]:
        """List pages in a course"""
        pages = []
        for page in self.pages.values():
            if page.get("course_id") == course_id:
                pages.append({
                    "url": page["url"],
                    "title": page["title"],
                    "created_at": page["created_at"],
                    "updated_at": page["updated_at"],
                    "published": page["published"],
                    "front_page": page["front_page"],
                    "locked_for_user": page["locked_for_user"]
                })
        return pages
    
    def get_page(self, course_id: int, page_url: str) -> Optional[Dict]:
        """Get page content"""
        for page in self.pages.values():
            if page.get("course_id") == course_id and page["url"] == page_url:
                return page
        return None
    
    # Calendar & Dashboard methods
    def list_calendar_events(self, start_date: str = None, end_date: str = None) -> List[Dict]:
        """List calendar events"""
        events = []
        for event in self.calendar_events.values():
            # Simple date filtering if provided
            if start_date or end_date:
                event_date = event["start_at"]
                if start_date and event_date < start_date:
                    continue
                if end_date and event_date > end_date:
                    continue
            events.append(event)
        return events
    
    def get_upcoming_assignments(self, limit: int = 10) -> List[Dict]:
        """Get upcoming assignment due dates"""
        upcoming = []
        current_time = datetime.now(timezone.utc).isoformat()
        
        for assignment in self.assignments.values():
            if assignment.get("due_at") and assignment["due_at"] > current_time:
                course = self.courses.get(str(assignment["course_id"]))
                upcoming.append({
                    "assignment": assignment,
                    "course": course
                })
        
        # Sort by due date and limit
        upcoming.sort(key=lambda x: x["assignment"]["due_at"])
        return upcoming[:limit]
    
    def get_dashboard(self) -> Dict:
        """Get user dashboard information"""
        courses = self.list_courses()
        upcoming = self.get_upcoming_assignments(5)
        
        return {
            "courses": courses,
            "upcoming_assignments": upcoming,
            "user": self.get_user_profile()
        }
    
    def get_dashboard_cards(self) -> List[Dict]:
        """Get dashboard course cards"""
        courses = self.list_courses()
        cards = []
        
        for course in courses:
            cards.append({
                "id": course["id"],
                "shortName": course.get("course_code", course["name"][:10]),
                "originalName": course["name"],
                "courseCode": course.get("course_code"),
                "assetString": f"course_{course['id']}",
                "href": f"/courses/{course['id']}",
                "term": None,
                "subtitle": course.get("syllabus_body", "")[:100] if course.get("syllabus_body") else "",
                "enrollmentType": "StudentEnrollment",
                "observee": None,
                "image": None,
                "color": None,
                "position": None
            })
        
        return cards
    
    # Grades methods
    def get_course_grades(self, course_id: int) -> Dict:
        """Get grades for a course"""
        course_key = f"course_{course_id}"
        user_grades = self.grades.get(course_key, {}).get(str(self.current_user_id), {})
        return user_grades
    
    def get_user_grades(self) -> Dict:
        """Get all grades for the current user"""
        all_grades = {}
        for course_key, course_grades in self.grades.items():
            if str(self.current_user_id) in course_grades:
                course_id = course_key.split("_")[1]
                all_grades[course_id] = course_grades[str(self.current_user_id)]
        return all_grades
    
    # Enrollment methods
    def enroll_user(self, course_id: int, user_id: int, role: str = "StudentEnrollment", enrollment_state: str = "active") -> Dict:
        """Enroll a user in a course"""
        course_key = f"course_{course_id}"
        
        if course_key not in self.enrollments:
            self.enrollments[course_key] = {}
        
        # Generate new enrollment ID
        all_enrollment_ids = []
        for course_enrollments in self.enrollments.values():
            for enrollment in course_enrollments.values():
                if isinstance(enrollment, dict) and "id" in enrollment:
                    all_enrollment_ids.append(enrollment["id"])
        new_id = max(all_enrollment_ids, default=0) + 1
        
        enrollment = {
            "id": new_id,
            "user_id": user_id,
            "course_id": course_id,
            "type": role,
            "enrollment_state": enrollment_state,
            "role": role,
            "role_id": 3 if role == "StudentEnrollment" else 4,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        
        self.enrollments[course_key][str(user_id)] = enrollment
        self._save_json_file("enrollments.json", self.enrollments)
        
        return enrollment
    
    # Modules methods
    def list_modules(self, course_id: int) -> List[Dict]:
        """List modules in a course"""
        modules = []
        for module in self.modules.values():
            if module.get("course_id") == course_id:
                modules.append(module)
        return sorted(modules, key=lambda x: x.get("position", 0))
    
    def get_module(self, course_id: int, module_id: int) -> Optional[Dict]:
        """Get module details"""
        module = self.modules.get(str(module_id))
        if module and module.get("course_id") == course_id:
            return module
        return None
    
    def list_module_items(self, course_id: int, module_id: int) -> List[Dict]:
        """List items in a module"""
        module_key = f"module_{module_id}"
        items = []
        
        if module_key in self.module_items:
            for item in self.module_items[module_key].values():
                items.append(item)
        
        return sorted(items, key=lambda x: x.get("position", 0))
    
    def get_module_item(self, course_id: int, module_id: int, item_id: int) -> Optional[Dict]:
        """Get module item details"""
        module_key = f"module_{module_id}"
        if module_key in self.module_items:
            return self.module_items[module_key].get(str(item_id))
        return None
    
    def mark_module_item_complete(self, course_id: int, module_id: int, item_id: int) -> Optional[Dict]:
        """Mark a module item as complete"""
        module_key = f"module_{module_id}"
        if module_key in self.module_items and str(item_id) in self.module_items[module_key]:
            item = self.module_items[module_key][str(item_id)]
            item["completed"] = True
            self._save_json_file("module_items.json", self.module_items)
            return item
        return None
    
    # Discussions methods
    def list_discussion_topics(self, course_id: int) -> List[Dict]:
        """List discussion topics in a course"""
        topics = []
        for topic in self.discussions.values():
            if topic.get("course_id") == course_id:
                topics.append(topic)
        return topics
    
    def get_discussion_topic(self, course_id: int, topic_id: int) -> Optional[Dict]:
        """Get discussion topic details"""
        topic = self.discussions.get(str(topic_id))
        if topic and topic.get("course_id") == course_id:
            return topic
        return None
    
    def post_to_discussion(self, course_id: int, topic_id: int, message: str) -> Dict:
        """Post a message to a discussion topic"""
        # This is a simplified implementation
        post = {
            "id": len(self.discussions) + 100,  # Simple ID generation
            "user_id": self.current_user_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "message": message,
            "topic_id": topic_id
        }
        
        # Update discussion topic with new post count
        if str(topic_id) in self.discussions:
            self.discussions[str(topic_id)]["discussion_subentry_count"] += 1
            self.discussions[str(topic_id)]["last_reply_at"] = post["created_at"]
            self._save_json_file("discussions.json", self.discussions)
        
        return post
    
    # Announcements methods
    def list_announcements(self, course_id: int) -> List[Dict]:
        """List announcements in a course"""
        announcements = []
        for announcement in self.announcements.values():
            if announcement.get("course_id") == course_id:
                announcements.append(announcement)
        return sorted(announcements, key=lambda x: x["posted_at"], reverse=True)
    
    def create_announcement(self, course_id: int, announcement_data: Dict) -> Dict:
        """Create a new announcement in a course"""
        new_id = max([int(k) for k in self.announcements.keys()], default=0) + 1
        
        announcement = {
            "id": new_id,
            "course_id": course_id,
            "title": announcement_data.get("title", "Untitled Announcement"),
            "message": announcement_data.get("content", announcement_data.get("message", "")),
            "posted_at": datetime.now(timezone.utc).isoformat(),
            "author": {
                "id": self.current_user_id,
                "display_name": "Instructor"
            },
            "url": f"http://localhost:10001/courses/{course_id}/announcements/{new_id}",
            "html_url": f"http://localhost:10001/courses/{course_id}/announcements/{new_id}"
        }
        
        self.announcements[str(new_id)] = announcement
        self._save_json_file("announcements.json", self.announcements)
        
        return announcement
    
    # Quizzes methods
    def list_quizzes(self, course_id: int) -> List[Dict]:
        """List quizzes in a course"""
        quizzes = []
        for quiz in self.quizzes.values():
            if quiz.get("course_id") == course_id:
                quizzes.append(quiz)
        return quizzes
    
    def get_quiz(self, course_id: int, quiz_id: int) -> Optional[Dict]:
        """Get quiz details"""
        quiz = self.quizzes.get(str(quiz_id))
        if quiz and quiz.get("course_id") == course_id:
            return quiz
        return None
    
    def create_quiz(self, course_id: int, quiz_data: Dict) -> Dict:
        """Create a new quiz"""
        new_id = max([int(k) for k in self.quizzes.keys()], default=0) + 1
        
        quiz = {
            "id": new_id,
            "course_id": course_id,
            "title": quiz_data.get("title", "Untitled Quiz"),
            "description": quiz_data.get("description", ""),
            "quiz_type": quiz_data.get("quiz_type", "assignment"),
            "time_limit": quiz_data.get("time_limit"),
            "due_at": quiz_data.get("due_at"),
            "published": quiz_data.get("published", False),
            "html_url": f"http://localhost:10001/courses/{course_id}/quizzes/{new_id}",
            "question_count": 0,
            "points_possible": 0,
            "allowed_attempts": 1,
            "scoring_policy": "keep_highest"
        }
        
        quiz.update(quiz_data)
        self.quizzes[str(new_id)] = quiz
        self._save_json_file("quizzes.json", self.quizzes)
        
        return quiz
    
    def start_quiz_attempt(self, course_id: int, quiz_id: int) -> Dict:
        """Start a new quiz attempt"""
        # Simplified implementation
        return {
            "id": 1,
            "quiz_id": quiz_id,
            "user_id": self.current_user_id,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "workflow_state": "preview"
        }
    def update_quiz(self, course_id: int, quiz_id: int, updates: Dict) -> Optional[Dict]:
        """Update an existing quiz"""
        quiz = self.quizzes.get(str(quiz_id))
        if not quiz or quiz.get("course_id") != course_id:
            return None
        
        quiz.update(updates)
        self._save_json_file("quizzes.json", self.quizzes)
        return quiz
    
    def publish_quiz(self, course_id: int, quiz_id: int) -> Optional[Dict]:
        """Publish a quiz"""
        return self.update_quiz(course_id, quiz_id, {"published": True})
    
    def delete_quiz(self, course_id: int, quiz_id: int) -> bool:
        """Delete a quiz"""
        quiz = self.quizzes.get(str(quiz_id))
        if not quiz or quiz.get("course_id") != course_id:
            return False
        
        del self.quizzes[str(quiz_id)]
        self._save_json_file("quizzes.json", self.quizzes)
        return True
    
    def add_quiz_question(self, course_id: int, quiz_id: int, question_data: Dict) -> Optional[Dict]:
        """Add a question to a quiz"""
        quiz = self.quizzes.get(str(quiz_id))
        if not quiz or quiz.get("course_id") != course_id:
            return None
        
        # Initialize questions array if not exists
        if "questions" not in quiz:
            quiz["questions"] = []
        
        # Generate question ID
        question_id = len(quiz["questions"]) + 1
        
        question = {
            "id": question_id,
            "quiz_id": quiz_id,
            "question_name": question_data.get("question_name", f"Question {question_id}"),
            "question_text": question_data.get("question_text", ""),
            "question_type": question_data.get("question_type", "multiple_choice_question"),
            "points_possible": question_data.get("points_possible", 1),
            "answers": question_data.get("answers", [])
        }
        
        quiz["questions"].append(question)
        quiz["question_count"] = len(quiz["questions"])
        quiz["points_possible"] = sum(q.get("points_possible", 0) for q in quiz["questions"])
        
        self._save_json_file("quizzes.json", self.quizzes)
        return question
    
    def get_quiz_questions(self, course_id: int, quiz_id: int) -> List[Dict]:
        """Get all questions for a quiz"""
        quiz = self.quizzes.get(str(quiz_id))
        if not quiz or quiz.get("course_id") != course_id:
            return []
        
        return quiz.get("questions", [])
    
    def update_quiz_question(self, course_id: int, quiz_id: int, question_id: int, updates: Dict) -> Optional[Dict]:
        """Update a quiz question"""
        quiz = self.quizzes.get(str(quiz_id))
        if not quiz or quiz.get("course_id") != course_id:
            return None
        
        questions = quiz.get("questions", [])
        for question in questions:
            if question.get("id") == question_id:
                question.update(updates)
                self._save_json_file("quizzes.json", self.quizzes)
                return question
        
        return None
    
    def delete_quiz_question(self, course_id: int, quiz_id: int, question_id: int) -> bool:
        """Delete a quiz question"""
        quiz = self.quizzes.get(str(quiz_id))
        if not quiz or quiz.get("course_id") != course_id:
            return False
        
        questions = quiz.get("questions", [])
        quiz["questions"] = [q for q in questions if q.get("id") != question_id]
        quiz["question_count"] = len(quiz["questions"])
        quiz["points_possible"] = sum(q.get("points_possible", 0) for q in quiz["questions"])
        
        self._save_json_file("quizzes.json", self.quizzes)
        return True 
    # Rubrics methods
    def list_rubrics(self, course_id: int) -> List[Dict]:
        """List rubrics for a course"""
        rubrics = []
        for rubric in self.rubrics.values():
            if rubric.get("context_id") == course_id and rubric.get("context_type") == "Course":
                rubrics.append(rubric)
        return rubrics
    
    def get_rubric(self, course_id: int, rubric_id: int) -> Optional[Dict]:
        """Get rubric details"""
        rubric = self.rubrics.get(str(rubric_id))
        if rubric and rubric.get("context_id") == course_id:
            return rubric
        return None
    
    # Conversations methods
    def list_conversations(self) -> List[Dict]:
        """List user's conversations"""
        conversations = []
        for conversation in self.conversations.values():
            # Check if current user is a participant
            participant_ids = [p["id"] for p in conversation.get("participants", [])]
            if self.current_user_id in participant_ids:
                conversations.append(conversation)
        return conversations
    
    def get_conversation(self, conversation_id: int) -> Optional[Dict]:
        """Get conversation details"""
        return self.conversations.get(str(conversation_id))
    
    def create_conversation(self, recipients: List[str], body: str, subject: str = None) -> Dict:
        """Create a new conversation"""
        new_id = max([int(k) for k in self.conversations.keys()], default=0) + 1
        
        conversation = {
            "id": new_id,
            "subject": subject or "No Subject",
            "workflow_state": "unread",
            "last_message": body,
            "last_message_at": datetime.now(timezone.utc).isoformat(),
            "message_count": 1,
            "private": True,
            "participants": [{"id": self.current_user_id}],  # Simplified
            "messages": [
                {
                    "id": new_id,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "body": body,
                    "author_id": self.current_user_id
                }
            ]
        }
        
        self.conversations[str(new_id)] = conversation
        self._save_json_file("conversations.json", self.conversations)
        
        return conversation
    
    # Notifications methods
    def list_notifications(self) -> List[Dict]:
        """List user's notifications"""
        return list(self.notifications.values())
    
    # Account methods
    def get_account(self, account_id: int) -> Optional[Dict]:
        """Get account details"""
        return self.accounts.get(str(account_id))
    
    def list_account_courses(self, account_id: int, **kwargs) -> List[Dict]:
        """List courses for an account"""
        courses = []
        for course in self.courses.values():
            if course.get("account_id") == account_id:
                courses.append(course)
        return courses
    
    def list_account_users(self, account_id: int, **kwargs) -> List[Dict]:
        """List users for an account"""
        # Simplified - return all users
        return list(self.users.values())
    
    def create_user(self, account_id: int, user_data: Dict, pseudonym_data: Dict) -> Dict:
        """Create a new user in an account"""
        new_id = max([int(k) for k in self.users.keys()], default=0) + 1
        
        user = {
            "id": new_id,
            "name": user_data["name"],
            "short_name": user_data.get("short_name", user_data["name"]),
            "sortable_name": user_data.get("sortable_name", user_data["name"]),
            "login_id": pseudonym_data["unique_id"],
            "primary_email": pseudonym_data["unique_id"],
            "password": user_data.get("password", "default_password"),
            "time_zone": user_data.get("time_zone", "America/Denver"),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        
        self.users[str(new_id)] = user
        self._save_json_file("users.json", self.users)
        
        return user
    
    def list_sub_accounts(self, account_id: int) -> List[Dict]:
        """List sub-accounts for an account"""
        sub_accounts = []
        for account in self.accounts.values():
            if account.get("parent_account_id") == account_id:
                sub_accounts.append(account)
        return sub_accounts
    
    def get_account_reports(self, account_id: int) -> List[Dict]:
        """List available reports for an account"""
        # Simplified - return sample reports
        return [
            {"report": "student_assignment_outcome_map_csv", "title": "Student Competency"},
            {"report": "grade_export_csv", "title": "Grade Export"},
            {"report": "provisioning_csv", "title": "Provisioning"}
        ]
    
    def create_account_report(self, account_id: int, report_type: str, parameters: Dict = None) -> Dict:
        """Generate a report for an account"""
        return {
            "id": 1,
            "report": report_type,
            "file_url": f"http://localhost:10001/accounts/{account_id}/reports/{report_type}/files/1",
            "status": "complete",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "started_at": datetime.now(timezone.utc).isoformat(),
            "ended_at": datetime.now(timezone.utc).isoformat()
        }
    
    def get_syllabus(self, course_id: int) -> Optional[Dict]:
        """Get course syllabus"""
        course = self.get_course(course_id)
        if course:
            return {
                "syllabus_body": course.get("syllabus_body", "")
            }
        return None
    
    # Health check
    def health_check(self) -> Dict:
        """Perform health check"""
        current_user = self.get_user_profile()
        return {
            "status": "ok",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "user": current_user
        }