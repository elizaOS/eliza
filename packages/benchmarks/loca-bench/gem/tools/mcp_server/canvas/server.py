# Copyright 2025 AxonRL Team. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Canvas MCP Server

A Model Context Protocol server that provides Canvas LMS functionality
using local JSON files as the database.

Adapted from the mcp_convert canvas server to use FastMCP framework.
"""

import logging
import os
import sys
from datetime import datetime
from typing import Optional

# Suppress FastMCP banner and reduce log level (must be before import)
os.environ["FASTMCP_SHOW_CLI_BANNER"] = "false"

from fastmcp import FastMCP

# Handle both direct execution and module import
try:
    from .database import CanvasDatabase
except ImportError:
    # When running directly, add parent directory to path
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from database import CanvasDatabase

# Set up logger
logger = logging.getLogger(__name__)

app = FastMCP("canvas-mcp-server")

# Global database instance (will be initialized in main)
db: Optional[CanvasDatabase] = None


def _ensure_authenticated():
    """Check if a user is authenticated"""
    if not db or not db.authenticated:
        raise ValueError("User not authenticated. Please login first.")
    return db.current_user_id


# -----------------------------
# System & Health Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "Check the health and connectivity of the Canvas API",
        "readOnlyHint": True,
    }
)
def canvas_health_check() -> str:
    """
    Check the health and connectivity of the Canvas API

    Returns server status and basic information.
    """
    if db:
        user_info = ""
        if db.authenticated and db.current_user_id:
            user = db.users.get(str(db.current_user_id))
            if user:
                user_info = f", logged in as: {user.get('name', 'Unknown')}"
        return f"Canvas MCP Server is running{user_info}"
    return "Canvas MCP Server is running (database not initialized)"


# -----------------------------
# User Profile Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "Get current user's profile",
        "readOnlyHint": True,
    }
)
def canvas_get_user_profile() -> dict:
    """
    Get current user's profile

    Returns user profile data including name, email, bio, etc.
    """
    user_id = _ensure_authenticated()
    user = db.get_user_profile(user_id)
    if not user:
        raise ValueError(f"User not found: {user_id}")
    return user


@app.tool(annotations={"title": "Update current user's profile"})
def canvas_update_user_profile(
    name: Optional[str] = None,
    short_name: Optional[str] = None,
    bio: Optional[str] = None,
    title: Optional[str] = None,
    time_zone: Optional[str] = None,
) -> dict:
    """
    Update current user's profile

    - name: User's name
    - short_name: User's short name
    - bio: User's bio
    - title: User's title
    - time_zone: User's time zone
    """
    user_id = _ensure_authenticated()
    updates = {}
    if name is not None:
        updates["name"] = name
    if short_name is not None:
        updates["short_name"] = short_name
    if bio is not None:
        updates["bio"] = bio
    if title is not None:
        updates["title"] = title
    if time_zone is not None:
        updates["time_zone"] = time_zone

    return db.update_user_profile(user_id, updates)


# -----------------------------
# Course Management Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "List all courses for the current user",
        "readOnlyHint": True,
    }
)
def canvas_list_courses(include_ended: bool = False) -> list:
    """
    List all courses for the current user

    - include_ended: Include ended courses

    Returns a list of courses the user is enrolled in.
    """
    user_id = _ensure_authenticated()
    return db.list_courses(user_id, include_ended=include_ended)


@app.tool(
    annotations={
        "title": "Get detailed information about a specific course",
        "readOnlyHint": True,
    }
)
def canvas_get_course(course_id: int) -> dict:
    """
    Get detailed information about a specific course

    - course_id: ID of the course

    Returns course details including name, code, term, etc.
    """
    _ensure_authenticated()
    course = db.get_course(course_id)
    if not course:
        raise ValueError(f"Course not found: {course_id}")
    return course


@app.tool(annotations={"title": "Create a new course in Canvas"})
def canvas_create_course(
    account_id: int,
    name: str,
    course_code: Optional[str] = None,
    start_at: Optional[str] = None,
    end_at: Optional[str] = None,
    syllabus_body: Optional[str] = None,
    is_public: bool = False,
    time_zone: Optional[str] = None,
) -> dict:
    """
    Create a new course in Canvas

    - account_id: ID of the account to create the course in
    - name: Name of the course
    - course_code: Course code (e.g., CS101)
    - start_at: Course start date (ISO format)
    - end_at: Course end date (ISO format)
    - syllabus_body: Course syllabus content
    - is_public: Whether the course is public
    - time_zone: Course time zone

    Returns the created course object.
    """
    _ensure_authenticated()
    course_data = {
        "name": name,
        "course_code": course_code or name[:10].upper(),
        "start_at": start_at,
        "end_at": end_at,
        "syllabus_body": syllabus_body,
        "is_public": is_public,
        "time_zone": time_zone,
    }
    return db.create_course(account_id, course_data)


@app.tool(annotations={"title": "Update an existing course in Canvas"})
def canvas_update_course(
    course_id: int,
    name: Optional[str] = None,
    course_code: Optional[str] = None,
    start_at: Optional[str] = None,
    end_at: Optional[str] = None,
    syllabus_body: Optional[str] = None,
) -> dict:
    """
    Update an existing course in Canvas

    - course_id: ID of the course to update
    - name: New name for the course
    - course_code: New course code
    - start_at: New start date (ISO format)
    - end_at: New end date (ISO format)
    - syllabus_body: Updated syllabus content

    Returns the updated course object.
    """
    _ensure_authenticated()
    updates = {}
    if name is not None:
        updates["name"] = name
    if course_code is not None:
        updates["course_code"] = course_code
    if start_at is not None:
        updates["start_at"] = start_at
    if end_at is not None:
        updates["end_at"] = end_at
    if syllabus_body is not None:
        updates["syllabus_body"] = syllabus_body

    return db.update_course(course_id, updates)


@app.tool(
    annotations={
        "title": "Get course syllabus",
        "readOnlyHint": True,
    }
)
def canvas_get_syllabus(course_id: int) -> dict:
    """
    Get course syllabus

    - course_id: ID of the course

    Returns the course syllabus content.
    """
    _ensure_authenticated()
    syllabus = db.get_syllabus(course_id)
    if not syllabus:
        raise ValueError(f"Syllabus not found for course: {course_id}")
    return syllabus


# -----------------------------
# Assignment Management Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "List assignments for a course",
        "readOnlyHint": True,
    }
)
def canvas_list_assignments(course_id: int) -> list:
    """
    List assignments for a course

    - course_id: ID of the course

    Returns a list of assignments.
    """
    _ensure_authenticated()
    return db.list_assignments(course_id)


@app.tool(
    annotations={
        "title": "Get detailed information about a specific assignment",
        "readOnlyHint": True,
    }
)
def canvas_get_assignment(course_id: int, assignment_id: int) -> dict:
    """
    Get detailed information about a specific assignment

    - course_id: ID of the course
    - assignment_id: ID of the assignment

    Returns assignment details.
    """
    _ensure_authenticated()
    assignment = db.get_assignment(course_id, assignment_id)
    if not assignment:
        raise ValueError(f"Assignment not found: {assignment_id}")
    return assignment


@app.tool(annotations={"title": "Create a new assignment in a Canvas course"})
def canvas_create_assignment(
    course_id: int,
    name: str,
    description: Optional[str] = None,
    points_possible: Optional[float] = None,
    due_at: Optional[str] = None,
    submission_types: Optional[list] = None,
    published: bool = True,
) -> dict:
    """
    Create a new assignment in a Canvas course

    - course_id: ID of the course
    - name: Name of the assignment
    - description: Assignment description/instructions
    - points_possible: Maximum points possible
    - due_at: Due date (ISO format)
    - submission_types: Allowed submission types
    - published: Whether the assignment is published

    Returns the created assignment object.
    """
    _ensure_authenticated()
    assignment_data = {
        "name": name,
        "description": description or "",
        "points_possible": points_possible or 100,
        "due_at": due_at,
        "submission_types": submission_types or ["online_text_entry"],
        "published": published,
    }
    return db.create_assignment(course_id, assignment_data)


@app.tool(annotations={"title": "Update an existing assignment"})
def canvas_update_assignment(
    course_id: int,
    assignment_id: int,
    name: Optional[str] = None,
    description: Optional[str] = None,
    points_possible: Optional[float] = None,
    due_at: Optional[str] = None,
    published: Optional[bool] = None,
) -> dict:
    """
    Update an existing assignment

    - course_id: ID of the course
    - assignment_id: ID of the assignment to update
    - name: New name for the assignment
    - description: New assignment description
    - points_possible: New maximum points
    - due_at: New due date (ISO format)
    - published: Whether the assignment is published

    Returns the updated assignment object.
    """
    _ensure_authenticated()
    updates = {}
    if name is not None:
        updates["name"] = name
    if description is not None:
        updates["description"] = description
    if points_possible is not None:
        updates["points_possible"] = points_possible
    if due_at is not None:
        updates["due_at"] = due_at
    if published is not None:
        updates["published"] = published

    return db.update_assignment(course_id, assignment_id, updates)


# -----------------------------
# Submission Management Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "Get submission details for an assignment",
        "readOnlyHint": True,
    }
)
def canvas_get_submission(course_id: int, assignment_id: int, user_id: Optional[int] = None) -> dict:
    """
    Get submission details for an assignment

    - course_id: ID of the course
    - assignment_id: ID of the assignment
    - user_id: ID of the user (optional, defaults to self)

    Returns submission details including grade and feedback.
    """
    current_user_id = _ensure_authenticated()
    if user_id is None:
        user_id = current_user_id
    
    submission = db.get_submission(course_id, assignment_id, user_id)
    if not submission:
        raise ValueError(f"Submission not found for assignment {assignment_id}")
    return submission


@app.tool(annotations={"title": "Submit work for an assignment"})
def canvas_submit_assignment(
    course_id: int,
    assignment_id: int,
    submission_type: str,
    body: Optional[str] = None,
    url: Optional[str] = None,
) -> dict:
    """
    Submit work for an assignment

    - course_id: ID of the course
    - assignment_id: ID of the assignment
    - submission_type: Type of submission
    - body: Text content for text submissions
    - url: URL for URL submissions

    Returns the created submission object.
    """
    user_id = _ensure_authenticated()
    submission_data = {
        "submission_type": submission_type,
        "body": body,
        "url": url,
    }
    return db.submit_assignment(course_id, assignment_id, user_id, submission_data)


@app.tool(annotations={"title": "Submit a grade for a student's assignment (teacher only)"})
def canvas_submit_grade(
    course_id: int,
    assignment_id: int,
    user_id: int,
    grade: float,
    comment: Optional[str] = None,
) -> dict:
    """
    Submit a grade for a student's assignment (teacher only)

    - course_id: ID of the course
    - assignment_id: ID of the assignment
    - user_id: ID of the student
    - grade: Grade to submit (number or letter grade)
    - comment: Optional comment on the submission

    Returns the updated submission object.
    """
    _ensure_authenticated()
    return db.submit_grade(course_id, assignment_id, user_id, grade, comment)


# -----------------------------
# Dashboard & Calendar Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "Get user's dashboard information",
        "readOnlyHint": True,
    }
)
def canvas_get_dashboard() -> dict:
    """
    Get user's dashboard information

    Returns dashboard data including recent activity and course cards.
    """
    user_id = _ensure_authenticated()
    return db.get_dashboard(user_id)


@app.tool(
    annotations={
        "title": "Get upcoming assignment due dates",
        "readOnlyHint": True,
    }
)
def canvas_get_upcoming_assignments() -> list:
    """
    Get upcoming assignment due dates

    Returns a list of assignments sorted by due date.
    """
    user_id = _ensure_authenticated()
    return db.get_upcoming_assignments(user_id)


@app.tool(
    annotations={
        "title": "List calendar events",
        "readOnlyHint": True,
    }
)
def canvas_list_calendar_events(
    start_date: Optional[str] = None, 
    end_date: Optional[str] = None
) -> list:
    """
    List calendar events

    - start_date: Start date for events (ISO format)
    - end_date: End date for events (ISO format)

    Returns a list of calendar events.
    """
    user_id = _ensure_authenticated()
    return db.list_calendar_events(user_id, start_date=start_date, end_date=end_date)


# -----------------------------
# Grades Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "Get grades for a course",
        "readOnlyHint": True,
    }
)
def canvas_get_course_grades(course_id: int) -> dict:
    """
    Get grades for a course

    - course_id: ID of the course

    Returns grade information for the current user in the course.
    """
    user_id = _ensure_authenticated()
    return db.get_course_grades(course_id, user_id)


@app.tool(
    annotations={
        "title": "Get all grades for the current user",
        "readOnlyHint": True,
    }
)
def canvas_get_user_grades() -> list:
    """
    Get all grades for the current user

    Returns a list of grades organized by course.
    """
    user_id = _ensure_authenticated()
    return db.get_user_grades(user_id)


# -----------------------------
# Authentication Tools
# -----------------------------


# @app.tool(annotations={"title": "Login as a specific user"})
# def canvas_login(login_id: str, password: str) -> dict:
#     """
#     Login as a specific user

#     - login_id: User login ID
#     - password: User password

#     Returns user information upon successful login.
#     """
#     result = db.login(login_id, password)
#     return result


# @app.tool(annotations={"title": "Logout the current user"})
# def canvas_logout() -> dict:
#     """
#     Logout the current user

#     Returns logout confirmation.
#     """
#     result = db.logout()
#     return result


# @app.tool(
#     annotations={
#         "title": "Get current logged in user information",
#         "readOnlyHint": True,
#     }
# )
# def canvas_get_current_user() -> dict:
#     """
#     Get current logged in user information

#     Returns the currently authenticated user's information.
#     """
#     result = db.get_current_user()
#     return result


# @app.tool(
#     annotations={
#         "title": "List all available users (for demo purposes)",
#         "readOnlyHint": True,
#     }
# )
# def canvas_list_users() -> list:
#     """
#     List all available users (for demo purposes)

#     Returns a list of all users in the system.
#     """
#     result = db.list_users()
#     return result


# -----------------------------
# Files & Folders Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "List files in a course or folder",
        "readOnlyHint": True,
    }
)
def canvas_list_files(course_id: int, folder_id: Optional[int] = None) -> list:
    """
    List files in a course or folder

    - course_id: ID of the course
    - folder_id: ID of the folder (optional)

    Returns a list of files.
    """
    _ensure_authenticated()
    return db.list_files(course_id, folder_id)


@app.tool(
    annotations={
        "title": "Get information about a specific file",
        "readOnlyHint": True,
    }
)
def canvas_get_file(file_id: int) -> dict:
    """
    Get information about a specific file

    - file_id: ID of the file

    Returns file metadata.
    """
    _ensure_authenticated()
    file_data = db.get_file(file_id)
    if not file_data:
        raise ValueError(f"File not found: {file_id}")
    return file_data


@app.tool(
    annotations={
        "title": "List folders in a course",
        "readOnlyHint": True,
    }
)
def canvas_list_folders(course_id: int) -> list:
    """
    List folders in a course

    - course_id: ID of the course

    Returns a list of folders.
    """
    _ensure_authenticated()
    return db.list_folders(course_id)


# -----------------------------
# Pages Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "List pages in a course",
        "readOnlyHint": True,
    }
)
def canvas_list_pages(course_id: int) -> list:
    """
    List pages in a course

    - course_id: ID of the course

    Returns a list of pages.
    """
    _ensure_authenticated()
    return db.list_pages(course_id)


@app.tool(
    annotations={
        "title": "Get content of a specific page",
        "readOnlyHint": True,
    }
)
def canvas_get_page(course_id: int, page_url: str) -> dict:
    """
    Get content of a specific page

    - course_id: ID of the course
    - page_url: URL slug of the page

    Returns page content.
    """
    _ensure_authenticated()
    page_data = db.get_page(course_id, page_url)
    if not page_data:
        raise ValueError(f"Page not found: {page_url} in course {course_id}")
    return page_data


@app.tool(
    annotations={
        "title": "Get dashboard course cards",
        "readOnlyHint": True,
    }
)
def canvas_get_dashboard_cards() -> list:
    """
    Get dashboard course cards

    Returns a list of course cards shown on the dashboard.
    """
    user_id = _ensure_authenticated()
    return db.get_dashboard_cards(user_id)


# -----------------------------
# Modules Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "List all modules in a course",
        "readOnlyHint": True,
    }
)
def canvas_list_modules(course_id: int) -> list:
    """
    List all modules in a course

    - course_id: ID of the course

    Returns a list of modules.
    """
    _ensure_authenticated()
    return db.list_modules(course_id)


@app.tool(
    annotations={
        "title": "Get details of a specific module",
        "readOnlyHint": True,
    }
)
def canvas_get_module(course_id: int, module_id: int) -> dict:
    """
    Get details of a specific module

    - course_id: ID of the course
    - module_id: ID of the module

    Returns module details.
    """
    _ensure_authenticated()
    module_data = db.get_module(course_id, module_id)
    if not module_data:
        raise ValueError(f"Module not found: {module_id} in course {course_id}")
    return module_data


@app.tool(
    annotations={
        "title": "List all items in a module",
        "readOnlyHint": True,
    }
)
def canvas_list_module_items(course_id: int, module_id: int) -> list:
    """
    List all items in a module

    - course_id: ID of the course
    - module_id: ID of the module

    Returns a list of module items.
    """
    _ensure_authenticated()
    return db.list_module_items(course_id, module_id)


@app.tool(
    annotations={
        "title": "Get details of a specific module item",
        "readOnlyHint": True,
    }
)
def canvas_get_module_item(course_id: int, module_id: int, item_id: int) -> dict:
    """
    Get details of a specific module item

    - course_id: ID of the course
    - module_id: ID of the module
    - item_id: ID of the module item

    Returns module item details.
    """
    _ensure_authenticated()
    item_data = db.get_module_item(course_id, module_id, item_id)
    if not item_data:
        raise ValueError(f"Module item not found: {item_id} in module {module_id}")
    return item_data


@app.tool(annotations={"title": "Mark a module item as complete"})
def canvas_mark_module_item_complete(course_id: int, module_id: int, item_id: int) -> dict:
    """
    Mark a module item as complete

    - course_id: ID of the course
    - module_id: ID of the module
    - item_id: ID of the module item

    Returns updated module item.
    """
    _ensure_authenticated()
    result = db.mark_module_item_complete(course_id, module_id, item_id)
    if not result:
        raise ValueError(f"Failed to mark module item {item_id} as complete")
    return result


# -----------------------------
# Discussions Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "List all discussion topics in a course",
        "readOnlyHint": True,
    }
)
def canvas_list_discussion_topics(course_id: int) -> list:
    """
    List all discussion topics in a course

    - course_id: ID of the course

    Returns a list of discussion topics.
    """
    _ensure_authenticated()
    return db.list_discussion_topics(course_id)


@app.tool(
    annotations={
        "title": "Get details of a specific discussion topic",
        "readOnlyHint": True,
    }
)
def canvas_get_discussion_topic(course_id: int, topic_id: int) -> dict:
    """
    Get details of a specific discussion topic

    - course_id: ID of the course
    - topic_id: ID of the discussion topic

    Returns discussion topic details.
    """
    _ensure_authenticated()
    topic_data = db.get_discussion_topic(course_id, topic_id)
    if not topic_data:
        raise ValueError(f"Discussion topic not found: {topic_id} in course {course_id}")
    return topic_data


@app.tool(annotations={"title": "Post a message to a discussion topic"})
def canvas_post_to_discussion(course_id: int, topic_id: int, message: str) -> dict:
    """
    Post a message to a discussion topic

    - course_id: ID of the course
    - topic_id: ID of the discussion topic
    - message: Message content

    Returns the created post.
    """
    _ensure_authenticated()
    return db.post_to_discussion(course_id, topic_id, message)


# -----------------------------
# Announcements Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "List all announcements in a course",
        "readOnlyHint": True,
    }
)
def canvas_list_announcements(course_id: int) -> list:
    """
    List all announcements in a course

    - course_id: ID of the course

    Returns a list of announcements.
    """
    _ensure_authenticated()
    return db.list_announcements(course_id)


# -----------------------------
# Quizzes Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "List all quizzes in a course",
        "readOnlyHint": True,
    }
)
def canvas_list_quizzes(course_id: int) -> list:
    """
    List all quizzes in a course

    - course_id: ID of the course

    Returns a list of quizzes.
    """
    _ensure_authenticated()
    return db.list_quizzes(course_id)


@app.tool(
    annotations={
        "title": "Get details of a specific quiz",
        "readOnlyHint": True,
    }
)
def canvas_get_quiz(course_id: int, quiz_id: int) -> dict:
    """
    Get details of a specific quiz

    - course_id: ID of the course
    - quiz_id: ID of the quiz

    Returns quiz details.
    """
    _ensure_authenticated()
    quiz_data = db.get_quiz(course_id, quiz_id)
    if not quiz_data:
        raise ValueError(f"Quiz not found: {quiz_id} in course {course_id}")
    return quiz_data


@app.tool(annotations={"title": "Create a new quiz in a course"})
def canvas_create_quiz(
    course_id: int,
    title: str,
    description: Optional[str] = None,
    quiz_type: Optional[str] = None,
    time_limit: Optional[int] = None,
    due_at: Optional[str] = None,
    published: bool = False,
) -> dict:
    """
    Create a new quiz in a course

    - course_id: ID of the course
    - title: Title of the quiz
    - description: Description of the quiz
    - quiz_type: Type of the quiz (e.g., graded)
    - time_limit: Time limit in minutes
    - due_at: Due date (ISO format)
    - published: Is the quiz published

    Returns the created quiz object.
    """
    _ensure_authenticated()
    quiz_data = {
        "title": title,
        "description": description,
        "quiz_type": quiz_type,
        "time_limit": time_limit,
        "due_at": due_at,
        "published": published,
    }
    return db.create_quiz(course_id, quiz_data)


@app.tool(annotations={"title": "Start a new quiz attempt"})
def canvas_start_quiz_attempt(course_id: int, quiz_id: int) -> dict:
    """
    Start a new quiz attempt

    - course_id: ID of the course
    - quiz_id: ID of the quiz

    Returns the quiz attempt object.
    """
    _ensure_authenticated()
    return db.start_quiz_attempt(course_id, quiz_id)


@app.tool(annotations={"title": "Update an existing quiz"})
def canvas_update_quiz(
    course_id: int,
    quiz_id: int,
    title: Optional[str] = None,
    description: Optional[str] = None,
    quiz_type: Optional[str] = None,
    time_limit: Optional[int] = None,
    due_at: Optional[str] = None,
    published: Optional[bool] = None,
    shuffle_answers: Optional[bool] = None,
    allowed_attempts: Optional[int] = None,
    scoring_policy: Optional[str] = None,
    access_code: Optional[str] = None,
) -> dict:
    """
    Update an existing quiz

    - course_id: ID of the course
    - quiz_id: ID of the quiz
    - title: New title
    - description: New description
    - quiz_type: Quiz type
    - time_limit: Time limit in minutes
    - due_at: Due date (ISO format)
    - published: Is published
    - shuffle_answers: Shuffle answers
    - allowed_attempts: Number of attempts allowed
    - scoring_policy: Scoring policy (keep_highest, keep_latest, keep_average)
    - access_code: Access code/password for the quiz

    Returns the updated quiz object.
    """
    _ensure_authenticated()
    updates = {}
    if title is not None:
        updates["title"] = title
    if description is not None:
        updates["description"] = description
    if quiz_type is not None:
        updates["quiz_type"] = quiz_type
    if time_limit is not None:
        updates["time_limit"] = time_limit
    if due_at is not None:
        updates["due_at"] = due_at
    if published is not None:
        updates["published"] = published
    if shuffle_answers is not None:
        updates["shuffle_answers"] = shuffle_answers
    if allowed_attempts is not None:
        updates["allowed_attempts"] = allowed_attempts
    if scoring_policy is not None:
        updates["scoring_policy"] = scoring_policy
    if access_code is not None:
        updates["access_code"] = access_code

    result = db.update_quiz(course_id, quiz_id, updates)
    if not result:
        raise ValueError(f"Quiz not found: {quiz_id} in course {course_id}")
    return result


@app.tool(annotations={"title": "Publish a quiz to make it available to students"})
def canvas_publish_quiz(course_id: int, quiz_id: int) -> dict:
    """
    Publish a quiz to make it available to students

    - course_id: ID of the course
    - quiz_id: ID of the quiz

    Returns the published quiz object.
    """
    _ensure_authenticated()
    result = db.publish_quiz(course_id, quiz_id)
    if not result:
        raise ValueError(f"Quiz not found: {quiz_id} in course {course_id}")
    return result


@app.tool(annotations={"title": "Delete a quiz"})
def canvas_delete_quiz(course_id: int, quiz_id: int) -> str:
    """
    Delete a quiz

    - course_id: ID of the course
    - quiz_id: ID of the quiz

    Returns deletion confirmation message.
    """
    _ensure_authenticated()
    success = db.delete_quiz(course_id, quiz_id)
    if success:
        return f"Quiz {quiz_id} deleted successfully"
    else:
        raise ValueError(f"Failed to delete quiz {quiz_id}")


@app.tool(annotations={"title": "Add a question to a quiz"})
def canvas_add_quiz_question(
    course_id: int,
    quiz_id: int,
    question_text: str,
    question_name: Optional[str] = None,
    question_type: Optional[str] = None,
    points_possible: Optional[float] = None,
    answers: Optional[list] = None,
) -> dict:
    """
    Add a question to a quiz

    - course_id: ID of the course
    - quiz_id: ID of the quiz
    - question_text: Question text/prompt
    - question_name: Question name/title
    - question_type: Type of question (multiple_choice_question, true_false_question, etc.)
    - points_possible: Points for this question
    - answers: Array of answer objects with answer_text and answer_weight (0-100)

    Returns the created question object.
    """
    _ensure_authenticated()
    question_data = {
        "question_name": question_name,
        "question_text": question_text,
        "question_type": question_type or "multiple_choice_question",
        "points_possible": points_possible or 1,
        "answers": answers or [],
    }
    result = db.add_quiz_question(course_id, quiz_id, question_data)
    if not result:
        raise ValueError(f"Quiz not found: {quiz_id} in course {course_id}")
    return result


@app.tool(
    annotations={
        "title": "Get all questions for a quiz",
        "readOnlyHint": True,
    }
)
def canvas_get_quiz_questions(course_id: int, quiz_id: int) -> list:
    """
    Get all questions for a quiz

    - course_id: ID of the course
    - quiz_id: ID of the quiz

    Returns a list of questions.
    """
    _ensure_authenticated()
    return db.get_quiz_questions(course_id, quiz_id)


@app.tool(annotations={"title": "Update a quiz question"})
def canvas_update_quiz_question(
    course_id: int,
    quiz_id: int,
    question_id: int,
    question_name: Optional[str] = None,
    question_text: Optional[str] = None,
    points_possible: Optional[float] = None,
    answers: Optional[list] = None,
) -> dict:
    """
    Update a quiz question

    - course_id: ID of the course
    - quiz_id: ID of the quiz
    - question_id: ID of the question
    - question_name: New question name
    - question_text: New question text
    - points_possible: New points value
    - answers: Updated answers

    Returns the updated question object.
    """
    _ensure_authenticated()
    updates = {}
    if question_name is not None:
        updates["question_name"] = question_name
    if question_text is not None:
        updates["question_text"] = question_text
    if points_possible is not None:
        updates["points_possible"] = points_possible
    if answers is not None:
        updates["answers"] = answers

    result = db.update_quiz_question(course_id, quiz_id, question_id, updates)
    if not result:
        raise ValueError(f"Question not found: {question_id} in quiz {quiz_id}")
    return result


@app.tool(annotations={"title": "Delete a quiz question"})
def canvas_delete_quiz_question(course_id: int, quiz_id: int, question_id: int) -> str:
    """
    Delete a quiz question

    - course_id: ID of the course
    - quiz_id: ID of the quiz
    - question_id: ID of the question

    Returns deletion confirmation message.
    """
    _ensure_authenticated()
    success = db.delete_quiz_question(course_id, quiz_id, question_id)
    if success:
        return f"Question {question_id} deleted successfully"
    else:
        raise ValueError(f"Failed to delete question {question_id}")


# -----------------------------
# Rubrics Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "List rubrics for a course",
        "readOnlyHint": True,
    }
)
def canvas_list_rubrics(course_id: int) -> list:
    """
    List rubrics for a course

    - course_id: ID of the course

    Returns a list of rubrics.
    """
    _ensure_authenticated()
    return db.list_rubrics(course_id)


@app.tool(
    annotations={
        "title": "Get details of a specific rubric",
        "readOnlyHint": True,
    }
)
def canvas_get_rubric(course_id: int, rubric_id: int) -> dict:
    """
    Get details of a specific rubric

    - course_id: ID of the course
    - rubric_id: ID of the rubric

    Returns rubric details.
    """
    _ensure_authenticated()
    rubric_data = db.get_rubric(course_id, rubric_id)
    if not rubric_data:
        raise ValueError(f"Rubric not found: {rubric_id} in course {course_id}")
    return rubric_data


# -----------------------------
# Conversations Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "List user's conversations",
        "readOnlyHint": True,
    }
)
def canvas_list_conversations() -> list:
    """
    List user's conversations

    Returns a list of conversations for the current user.
    """
    _ensure_authenticated()
    return db.list_conversations()


@app.tool(
    annotations={
        "title": "Get details of a specific conversation",
        "readOnlyHint": True,
    }
)
def canvas_get_conversation(conversation_id: int) -> dict:
    """
    Get details of a specific conversation

    - conversation_id: ID of the conversation

    Returns conversation details.
    """
    _ensure_authenticated()
    conversation_data = db.get_conversation(conversation_id)
    if not conversation_data:
        raise ValueError(f"Conversation not found: {conversation_id}")
    return conversation_data


@app.tool(annotations={"title": "Create a new conversation"})
def canvas_create_conversation(recipients: list, body: str, subject: Optional[str] = None) -> dict:
    """
    Create a new conversation

    - recipients: Recipient user IDs or email addresses
    - body: Message body
    - subject: Message subject

    Returns the created conversation object.
    """
    _ensure_authenticated()
    return db.create_conversation(recipients, body, subject)


# -----------------------------
# Notifications Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "List user's notifications",
        "readOnlyHint": True,
    }
)
def canvas_list_notifications() -> list:
    """
    List user's notifications

    Returns a list of notifications for the current user.
    """
    _ensure_authenticated()
    return db.list_notifications()


# -----------------------------
# Account Management Tools
# -----------------------------


@app.tool(
    annotations={
        "title": "Get account details",
        "readOnlyHint": True,
    }
)
def canvas_get_account(account_id: int) -> dict:
    """
    Get account details

    - account_id: ID of the account

    Returns account information.
    """
    _ensure_authenticated()
    account_data = db.get_account(account_id)
    if not account_data:
        raise ValueError(f"Account not found: {account_id}")
    return account_data


@app.tool(
    annotations={
        "title": "List courses for an account",
        "readOnlyHint": True,
    }
)
def canvas_list_account_courses(
    account_id: int,
    with_enrollments: Optional[bool] = None,
    published: Optional[bool] = None,
    completed: Optional[bool] = None,
    sort: Optional[str] = None,
    order: Optional[str] = None,
    search_term: Optional[str] = None,
) -> list:
    """
    List courses for an account

    - account_id: ID of the account
    - with_enrollments: Include enrollment data
    - published: Only include published courses
    - completed: Include completed courses
    - sort: Sort order (course_name, sis_course_id, teacher, account_name)
    - order: Sort direction (asc, desc)
    - search_term: Search term to filter courses

    Returns a list of courses.
    """
    _ensure_authenticated()
    kwargs = {
        "with_enrollments": with_enrollments,
        "published": published,
        "completed": completed,
        "sort": sort,
        "order": order,
        "search_term": search_term,
    }
    # Remove None values
    kwargs = {k: v for k, v in kwargs.items() if v is not None}
    return db.list_account_courses(account_id, **kwargs)


@app.tool(
    annotations={
        "title": "List users for an account",
        "readOnlyHint": True,
    }
)
def canvas_list_account_users(
    account_id: int,
    sort: Optional[str] = None,
    order: Optional[str] = None,
    search_term: Optional[str] = None,
) -> list:
    """
    List users for an account

    - account_id: ID of the account
    - sort: Sort order (username, email, sis_id, last_login)
    - order: Sort direction (asc, desc)
    - search_term: Search term to filter users

    Returns a list of users.
    """
    _ensure_authenticated()
    kwargs = {
        "sort": sort,
        "order": order,
        "search_term": search_term,
    }
    # Remove None values
    kwargs = {k: v for k, v in kwargs.items() if v is not None}
    return db.list_account_users(account_id, **kwargs)


@app.tool(annotations={"title": "Create a new user in an account"})
def canvas_create_user(account_id: int, user: dict, pseudonym: dict) -> dict:
    """
    Create a new user in an account

    - account_id: ID of the account
    - user: User data object with name, short_name, sortable_name, time_zone
    - pseudonym: Pseudonym data object with unique_id, password, sis_user_id, send_confirmation

    Returns the created user object.
    """
    _ensure_authenticated()
    return db.create_user(account_id, user, pseudonym)


@app.tool(
    annotations={
        "title": "List sub-accounts for an account",
        "readOnlyHint": True,
    }
)
def canvas_list_sub_accounts(account_id: int) -> list:
    """
    List sub-accounts for an account

    - account_id: ID of the parent account

    Returns a list of sub-accounts.
    """
    _ensure_authenticated()
    return db.list_sub_accounts(account_id)


@app.tool(
    annotations={
        "title": "List available reports for an account",
        "readOnlyHint": True,
    }
)
def canvas_get_account_reports(account_id: int) -> list:
    """
    List available reports for an account

    - account_id: ID of the account

    Returns a list of available report types.
    """
    _ensure_authenticated()
    return db.get_account_reports(account_id)


@app.tool(annotations={"title": "Generate a report for an account"})
def canvas_create_account_report(
    account_id: int, report: str, parameters: Optional[dict] = None
) -> dict:
    """
    Generate a report for an account

    - account_id: ID of the account
    - report: Type of report to generate
    - parameters: Report parameters

    Returns the generated report object.
    """
    _ensure_authenticated()
    return db.create_account_report(account_id, report, parameters or {})


# -----------------------------
# Enrollment Tools
# -----------------------------


@app.tool(annotations={"title": "Enroll a user in a course"})
def canvas_enroll_user(
    course_id: int, 
    user_id: int, 
    enrollment_type: str = "StudentEnrollment",
    enrollment_state: str = "active",
) -> dict:
    """
    Enroll a user in a course

    - course_id: ID of the course
    - user_id: ID of the user to enroll
    - enrollment_type: Type of enrollment (StudentEnrollment, TeacherEnrollment, etc.)
    - enrollment_state: State of the enrollment (active, invited, etc.)

    Returns the created enrollment object.
    """
    _ensure_authenticated()
    return db.enroll_user(course_id, user_id, enrollment_type, enrollment_state)


if __name__ == "__main__":
    import argparse

    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Canvas MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "http", "streamable-http"],
        default="streamable-http",
        help="Transport protocol to use (default: streamable-http)",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind to for HTTP transport (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8082,
        help="Port to bind to for HTTP transport (default: 8082)",
    )
    parser.add_argument(
        "--path",
        default="/canvas-mcp",
        help="Path for HTTP endpoint (default: /canvas-mcp)",
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
        help="Log level (default: INFO)",
    )
    parser.add_argument(
        "--data-dir",
        type=str,
        help="Path to Canvas data directory (default: ./data)",
    )
    parser.add_argument(
        "--login-id",
        type=str,
        help="Auto-login with this Canvas login ID",
    )
    parser.add_argument(
        "--password",
        type=str,
        help="Password for auto-login",
    )

    args = parser.parse_args()

    # Configure logging
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    # Initialize database
    data_dir = args.data_dir or os.path.join(os.path.dirname(__file__), "data")
    db = CanvasDatabase(data_dir=data_dir)
    
    # Auto-login if credentials provided
    if args.login_id and args.password:
        try:
            result = db.login(args.login_id, args.password)
            logger.info(f"Auto-logged in as: {result['name']} ({result['login_id']})")
        except Exception as e:
            logger.warning(f"Could not auto-login: {e}")

    # Run the server
    if args.transport in ["http", "streamable-http"]:
        logger.info("Starting Canvas MCP Server with Streamable HTTP transport")
        logger.info(
            f"Server will be available at: http://{args.host}:{args.port}{args.path}"
        )
        logger.info(f"Log level: {args.log_level}")
        logger.info("Press Ctrl+C to stop the server")
        app.run(
            transport="streamable-http",
            host=args.host,
            port=args.port,
            path=args.path,
            log_level=args.log_level.lower(),
            show_banner=False
        )
    else:
        # Default stdio transport
        logger.info("Starting Canvas MCP Server with stdio transport")
        app.run(transport="stdio", show_banner=False)
