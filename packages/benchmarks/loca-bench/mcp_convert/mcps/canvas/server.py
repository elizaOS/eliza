#!/usr/bin/env python3
"""
Simplified Canvas MCP Server

A Model Context Protocol server that provides Canvas LMS functionality
using local JSON files as the database instead of connecting to external APIs.

Uses the common MCP framework for simplified development.
"""

import asyncio
import logging
import sys
import os
import argparse
from typing import Any, Dict

# Suppress logging unless verbose mode is enabled
if os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes'):
    logging.basicConfig(level=logging.WARNING, force=True)
    logging.getLogger().setLevel(logging.WARNING)
    for _logger_name in ["mcp", "fastmcp", "mcp.server", "mcp.client"]:
        logging.getLogger(_logger_name).setLevel(logging.WARNING)

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from common.mcp.server_base import BaseMCPServer
from common.mcp.tools import ToolRegistry
from mcps.canvas.database_utils import CanvasDatabase


class CanvasMCPServer(BaseMCPServer):
    """Canvas MCP server implementation"""

    def __init__(self, login_id: str = None, password: str = None):
        super().__init__("simplified-canvas", "1.0.0")

        # Get data directory from environment variable or use default
        data_dir = os.environ.get('CANVAS_DATA_DIR')
        quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')
        if data_dir:
            if not quiet:
                print(f"Using Canvas data directory from environment: {data_dir}", file=sys.stderr)
            os.makedirs(data_dir, exist_ok=True)
        else:
            # Use default data directory if not specified
            data_dir = os.path.join(os.path.dirname(__file__), "data")
            if not quiet:
                print(f"Using default Canvas data directory: {data_dir}", file=sys.stderr)

        self.db = CanvasDatabase(data_dir=data_dir)
        self.tool_registry = ToolRegistry()
        self.auto_login_user = None

        # Auto-login if credentials provided
        if login_id and password:
            self._auto_login(login_id, password)
        # else:
        #     # Default to admin credentials if none supplied
        #     default_login = os.environ.get("CANVAS_DEFAULT_LOGIN", "admin")
        #     default_password = os.environ.get("CANVAS_DEFAULT_PASSWORD", "admin123")
        #     self._auto_login(default_login, default_password)

        self.setup_tools()

    def _auto_login(self, login_id: str, password: str):
        """Auto-login the user with provided credentials"""
        quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')
        try:
            # Auto-login
            result = self.db.login(login_id, password)
            self.auto_login_user = result
            if not quiet:
                print(f"Auto-logged in as: {result['name']} ({result['login_id']})", file=sys.stderr)
        except Exception as e:
            if not quiet:
                print(f"Warning: Could not auto-login: {e}", file=sys.stderr)
    
    def setup_tools(self):
        """Setup all Canvas tools"""
        
        # Health check
        self.tool_registry.register(
            name="canvas_health_check",
            description="Check the health and connectivity of the Canvas API",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.canvas_health_check
        )

        # Authentication tools
        self.tool_registry.register(
            name="canvas_login",
            description="Login as a specific user",
            input_schema={
                "type": "object",
                "properties": {
                    "login_id": {"type": "string", "description": "User login ID"},
                    "password": {"type": "string", "description": "User password"}
                },
                "required": ["login_id", "password"]
            },
            handler=self.canvas_login
        )

        self.tool_registry.register(
            name="canvas_logout",
            description="Logout the current user",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.canvas_logout
        )

        self.tool_registry.register(
            name="canvas_get_current_user",
            description="Get current logged in user information",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.canvas_get_current_user
        )

        self.tool_registry.register(
            name="canvas_list_users",
            description="List all available users (for demo purposes)",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.canvas_list_users
        )

        # User profile tools
        self.tool_registry.register(
            name="canvas_get_user_profile",
            description="Get current user's profile",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.canvas_get_user_profile
        )
        
        self.tool_registry.register(
            name="canvas_update_user_profile",
            description="Update current user's profile",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "User's name"},
                    "short_name": {"type": "string", "description": "User's short name"},
                    "bio": {"type": "string", "description": "User's bio"},
                    "title": {"type": "string", "description": "User's title"},
                    "time_zone": {"type": "string", "description": "User's time zone"}
                },
                "required": []
            },
            handler=self.canvas_update_user_profile
        )
        
        # Course tools
        self.tool_registry.register(
            name="canvas_list_courses",
            description="List all courses for the current user",
            input_schema={
                "type": "object",
                "properties": {
                    "include_ended": {"type": "boolean", "description": "Include ended courses"}
                },
                "required": []
            },
            handler=self.canvas_list_courses
        )
        
        self.tool_registry.register(
            name="canvas_get_course",
            description="Get detailed information about a specific course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_get_course
        )
        
        self.tool_registry.register(
            name="canvas_create_course",
            description="Create a new course in Canvas",
            input_schema={
                "type": "object",
                "properties": {
                    "account_id": {"type": "number", "description": "ID of the account to create the course in"},
                    "name": {"type": "string", "description": "Name of the course"},
                    "course_code": {"type": "string", "description": "Course code (e.g., CS101)"},
                    "start_at": {"type": "string", "description": "Course start date (ISO format)"},
                    "end_at": {"type": "string", "description": "Course end date (ISO format)"},
                    "syllabus_body": {"type": "string", "description": "Course syllabus content"},
                    "is_public": {"type": "boolean", "description": "Whether the course is public"},
                    "time_zone": {"type": "string", "description": "Course time zone"}
                },
                "required": ["account_id", "name"]
            },
            handler=self.canvas_create_course
        )
        
        self.tool_registry.register(
            name="canvas_update_course",
            description="Update an existing course in Canvas",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course to update"},
                    "name": {"type": "string", "description": "New name for the course"},
                    "course_code": {"type": "string", "description": "New course code"},
                    "start_at": {"type": "string", "description": "New start date (ISO format)"},
                    "end_at": {"type": "string", "description": "New end date (ISO format)"},
                    "syllabus_body": {"type": "string", "description": "Updated syllabus content"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_update_course
        )
        
        # Assignment tools
        self.tool_registry.register(
            name="canvas_list_assignments",
            description="List assignments for a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_list_assignments
        )
        
        self.tool_registry.register(
            name="canvas_get_assignment",
            description="Get detailed information about a specific assignment",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "assignment_id": {"type": "number", "description": "ID of the assignment"}
                },
                "required": ["course_id", "assignment_id"]
            },
            handler=self.canvas_get_assignment
        )
        
        self.tool_registry.register(
            name="canvas_create_assignment",
            description="Create a new assignment in a Canvas course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "name": {"type": "string", "description": "Name of the assignment"},
                    "description": {"type": "string", "description": "Assignment description/instructions"},
                    "points_possible": {"type": "number", "description": "Maximum points possible"},
                    "due_at": {"type": "string", "description": "Due date (ISO format)"},
                    "submission_types": {"type": "array", "items": {"type": "string"}, "description": "Allowed submission types"},
                    "published": {"type": "boolean", "description": "Whether the assignment is published"}
                },
                "required": ["course_id", "name"]
            },
            handler=self.canvas_create_assignment
        )
        
        self.tool_registry.register(
            name="canvas_update_assignment",
            description="Update an existing assignment",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "assignment_id": {"type": "number", "description": "ID of the assignment to update"},
                    "name": {"type": "string", "description": "New name for the assignment"},
                    "description": {"type": "string", "description": "New assignment description"},
                    "points_possible": {"type": "number", "description": "New maximum points"},
                    "due_at": {"type": "string", "description": "New due date (ISO format)"},
                    "published": {"type": "boolean", "description": "Whether the assignment is published"}
                },
                "required": ["course_id", "assignment_id"]
            },
            handler=self.canvas_update_assignment
        )
        
        # Submission tools
        self.tool_registry.register(
            name="canvas_get_submission",
            description="Get submission details for an assignment",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "assignment_id": {"type": "number", "description": "ID of the assignment"},
                    "user_id": {"type": "number", "description": "ID of the user (optional, defaults to self)"}
                },
                "required": ["course_id", "assignment_id"]
            },
            handler=self.canvas_get_submission
        )
        
        self.tool_registry.register(
            name="canvas_submit_assignment",
            description="Submit work for an assignment",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "assignment_id": {"type": "number", "description": "ID of the assignment"},
                    "submission_type": {"type": "string", "enum": ["online_text_entry", "online_url", "online_upload"], "description": "Type of submission"},
                    "body": {"type": "string", "description": "Text content for text submissions"},
                    "url": {"type": "string", "description": "URL for URL submissions"},
                    "file_ids": {"type": "array", "items": {"type": "number"}, "description": "File IDs for file submissions"}
                },
                "required": ["course_id", "assignment_id", "submission_type"]
            },
            handler=self.canvas_submit_assignment
        )
        
        self.tool_registry.register(
            name="canvas_submit_grade",
            description="Submit a grade for a student's assignment (teacher only)",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "assignment_id": {"type": "number", "description": "ID of the assignment"},
                    "user_id": {"type": "number", "description": "ID of the student"},
                    "grade": {"oneOf": [{"type": "number"}, {"type": "string"}], "description": "Grade to submit (number or letter grade)"},
                    "comment": {"type": "string", "description": "Optional comment on the submission"}
                },
                "required": ["course_id", "assignment_id", "user_id", "grade"]
            },
            handler=self.canvas_submit_grade
        )
        
        # Files & Folders tools
        self.tool_registry.register(
            name="canvas_list_files",
            description="List files in a course or folder",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "folder_id": {"type": "number", "description": "ID of the folder (optional)"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_list_files
        )
        
        self.tool_registry.register(
            name="canvas_get_file",
            description="Get information about a specific file",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "number", "description": "ID of the file"}
                },
                "required": ["file_id"]
            },
            handler=self.canvas_get_file
        )
        
        self.tool_registry.register(
            name="canvas_list_folders",
            description="List folders in a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_list_folders
        )
        
        # Pages tools
        self.tool_registry.register(
            name="canvas_list_pages",
            description="List pages in a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_list_pages
        )
        
        self.tool_registry.register(
            name="canvas_get_page",
            description="Get content of a specific page",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "page_url": {"type": "string", "description": "URL slug of the page"}
                },
                "required": ["course_id", "page_url"]
            },
            handler=self.canvas_get_page
        )
        
        # Calendar & Dashboard tools
        self.tool_registry.register(
            name="canvas_list_calendar_events",
            description="List calendar events",
            input_schema={
                "type": "object",
                "properties": {
                    "start_date": {"type": "string", "description": "Start date (ISO format)"},
                    "end_date": {"type": "string", "description": "End date (ISO format)"}
                },
                "required": []
            },
            handler=self.canvas_list_calendar_events
        )
        
        self.tool_registry.register(
            name="canvas_get_upcoming_assignments",
            description="Get upcoming assignment due dates",
            input_schema={
                "type": "object",
                "properties": {
                    "limit": {"type": "number", "description": "Maximum number of assignments to return"}
                },
                "required": []
            },
            handler=self.canvas_get_upcoming_assignments
        )
        
        self.tool_registry.register(
            name="canvas_get_dashboard",
            description="Get user's dashboard information",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.canvas_get_dashboard
        )
        
        self.tool_registry.register(
            name="canvas_get_dashboard_cards",
            description="Get dashboard course cards",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.canvas_get_dashboard_cards
        )
        
        # Grades tools
        self.tool_registry.register(
            name="canvas_get_course_grades",
            description="Get grades for a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_get_course_grades
        )
        
        self.tool_registry.register(
            name="canvas_get_user_grades",
            description="Get all grades for the current user",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.canvas_get_user_grades
        )
        
        # Enrollment tools
        self.tool_registry.register(
            name="canvas_enroll_user",
            description="Enroll a user in a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "user_id": {"type": "number", "description": "ID of the user to enroll"},
                    "role": {"type": "string", "description": "Role for the enrollment (StudentEnrollment, TeacherEnrollment, etc.)"},
                    "enrollment_state": {"type": "string", "description": "State of the enrollment (active, invited, etc.)"}
                },
                "required": ["course_id", "user_id"]
            },
            handler=self.canvas_enroll_user
        )
        
        # Modules tools
        self.tool_registry.register(
            name="canvas_list_modules",
            description="List all modules in a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_list_modules
        )
        
        self.tool_registry.register(
            name="canvas_get_module",
            description="Get details of a specific module",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "module_id": {"type": "number", "description": "ID of the module"}
                },
                "required": ["course_id", "module_id"]
            },
            handler=self.canvas_get_module
        )
        
        self.tool_registry.register(
            name="canvas_list_module_items",
            description="List all items in a module",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "module_id": {"type": "number", "description": "ID of the module"}
                },
                "required": ["course_id", "module_id"]
            },
            handler=self.canvas_list_module_items
        )
        
        self.tool_registry.register(
            name="canvas_get_module_item",
            description="Get details of a specific module item",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "module_id": {"type": "number", "description": "ID of the module"},
                    "item_id": {"type": "number", "description": "ID of the module item"}
                },
                "required": ["course_id", "module_id", "item_id"]
            },
            handler=self.canvas_get_module_item
        )
        
        self.tool_registry.register(
            name="canvas_mark_module_item_complete",
            description="Mark a module item as complete",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "module_id": {"type": "number", "description": "ID of the module"},
                    "item_id": {"type": "number", "description": "ID of the module item"}
                },
                "required": ["course_id", "module_id", "item_id"]
            },
            handler=self.canvas_mark_module_item_complete
        )

        self.tool_registry.register(
            name="canvas_create_module",
            description="Create a new module in a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "name": {"type": "string", "description": "Name of the module"},
                    "position": {"type": "number", "description": "Position/order of the module"},
                    "unlock_at": {"type": "string", "description": "Unlock date (ISO format)"},
                    "require_sequential_progress": {"type": "boolean", "description": "Require sequential progress through items"},
                    "prerequisite_module_ids": {"type": "array", "items": {"type": "number"}, "description": "IDs of prerequisite modules"},
                    "published": {"type": "boolean", "description": "Whether the module is published"}
                },
                "required": ["course_id", "name"]
            },
            handler=self.canvas_create_module
        )

        self.tool_registry.register(
            name="canvas_create_module_item",
            description="Add an item to a module",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "module_id": {"type": "number", "description": "ID of the module"},
                    "title": {"type": "string", "description": "Title of the module item"},
                    "type": {"type": "string", "enum": ["Assignment", "Quiz", "File", "Page", "Discussion", "ExternalUrl", "ExternalTool"], "description": "Type of content"},
                    "content_id": {"type": "number", "description": "ID of the content (assignment_id, page_id, etc.)"},
                    "html_url": {"type": "string", "description": "URL to the item"},
                    "url": {"type": "string", "description": "External URL (for ExternalUrl type)"},
                    "position": {"type": "number", "description": "Position within the module"},
                    "indent": {"type": "number", "description": "Indentation level (0-3)"},
                    "published": {"type": "boolean", "description": "Whether the item is published"}
                },
                "required": ["course_id", "module_id", "title", "type"]
            },
            handler=self.canvas_create_module_item
        )

        # Discussions tools
        self.tool_registry.register(
            name="canvas_list_discussion_topics",
            description="List all discussion topics in a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_list_discussion_topics
        )
        
        self.tool_registry.register(
            name="canvas_get_discussion_topic",
            description="Get details of a specific discussion topic",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "topic_id": {"type": "number", "description": "ID of the discussion topic"}
                },
                "required": ["course_id", "topic_id"]
            },
            handler=self.canvas_get_discussion_topic
        )
        
        self.tool_registry.register(
            name="canvas_post_to_discussion",
            description="Post a message to a discussion topic",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "topic_id": {"type": "number", "description": "ID of the discussion topic"},
                    "message": {"type": "string", "description": "Message content"}
                },
                "required": ["course_id", "topic_id", "message"]
            },
            handler=self.canvas_post_to_discussion
        )
        
        # Announcements tools
        self.tool_registry.register(
            name="canvas_list_announcements",
            description="List all announcements in a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_list_announcements
        )
        
        # Quizzes tools
        self.tool_registry.register(
            name="canvas_list_quizzes",
            description="List all quizzes in a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_list_quizzes
        )
        
        self.tool_registry.register(
            name="canvas_get_quiz",
            description="Get details of a specific quiz",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "quiz_id": {"type": "number", "description": "ID of the quiz"}
                },
                "required": ["course_id", "quiz_id"]
            },
            handler=self.canvas_get_quiz
        )
        
        self.tool_registry.register(
            name="canvas_create_quiz",
            description="Create a new quiz in a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "title": {"type": "string", "description": "Title of the quiz"},
                    "description": {"type": "string", "description": "Description of the quiz"},
                    "quiz_type": {"type": "string", "description": "Type of the quiz (e.g., graded)"},
                    "time_limit": {"type": "number", "description": "Time limit in minutes"},
                    "due_at": {"type": "string", "description": "Due date (ISO format)"},
                    "published": {"type": "boolean", "description": "Is the quiz published"}
                },
                "required": ["course_id", "title"]
            },
            handler=self.canvas_create_quiz
        )
        
        self.tool_registry.register(
            name="canvas_start_quiz_attempt",
            description="Start a new quiz attempt",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "quiz_id": {"type": "number", "description": "ID of the quiz"}
                },
                "required": ["course_id", "quiz_id"]
            },
            handler=self.canvas_start_quiz_attempt
        )
        
        self.tool_registry.register(
            name="canvas_update_quiz",
            description="Update an existing quiz",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "quiz_id": {"type": "number", "description": "ID of the quiz"},
                    "title": {"type": "string", "description": "New title"},
                    "description": {"type": "string", "description": "New description"},
                    "quiz_type": {"type": "string", "description": "Quiz type"},
                    "time_limit": {"type": "number", "description": "Time limit in minutes"},
                    "due_at": {"type": "string", "description": "Due date (ISO format)"},
                    "published": {"type": "boolean", "description": "Is published"},
                    "shuffle_answers": {"type": "boolean", "description": "Shuffle answers"},
                    "allowed_attempts": {"type": "number", "description": "Number of attempts allowed"},
                    "scoring_policy": {"type": "string", "description": "Scoring policy (keep_highest, keep_latest, keep_average)"},
                    "access_code": {"type": "string", "description": "Access code/password for the quiz"}
                },
                "required": ["course_id", "quiz_id"]
            },
            handler=self.canvas_update_quiz
        )
        
        self.tool_registry.register(
            name="canvas_publish_quiz",
            description="Publish a quiz to make it available to students",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "quiz_id": {"type": "number", "description": "ID of the quiz"}
                },
                "required": ["course_id", "quiz_id"]
            },
            handler=self.canvas_publish_quiz
        )
        
        self.tool_registry.register(
            name="canvas_delete_quiz",
            description="Delete a quiz",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "quiz_id": {"type": "number", "description": "ID of the quiz"}
                },
                "required": ["course_id", "quiz_id"]
            },
            handler=self.canvas_delete_quiz
        )
        
        self.tool_registry.register(
            name="canvas_add_quiz_question",
            description="Add a question to a quiz",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "quiz_id": {"type": "number", "description": "ID of the quiz"},
                    "question_name": {"type": "string", "description": "Question name/title"},
                    "question_text": {"type": "string", "description": "Question text/prompt"},
                    "question_type": {"type": "string", "description": "Type of question (multiple_choice_question, true_false_question, short_answer_question, essay_question, etc.)"},
                    "points_possible": {"type": "number", "description": "Points for this question"},
                    "answers": {"type": "array", "items": {"type": "object"}, "description": "Array of answer objects with answer_text and answer_weight (0-100)"}
                },
                "required": ["course_id", "quiz_id", "question_text"]
            },
            handler=self.canvas_add_quiz_question
        )
        
        self.tool_registry.register(
            name="canvas_get_quiz_questions",
            description="Get all questions for a quiz",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "quiz_id": {"type": "number", "description": "ID of the quiz"}
                },
                "required": ["course_id", "quiz_id"]
            },
            handler=self.canvas_get_quiz_questions
        )
        
        self.tool_registry.register(
            name="canvas_update_quiz_question",
            description="Update a quiz question",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "quiz_id": {"type": "number", "description": "ID of the quiz"},
                    "question_id": {"type": "number", "description": "ID of the question"},
                    "question_name": {"type": "string", "description": "New question name"},
                    "question_text": {"type": "string", "description": "New question text"},
                    "points_possible": {"type": "number", "description": "New points value"},
                    "answers": {"type": "array", "items": {"type": "object"}, "description": "Updated answers"}
                },
                "required": ["course_id", "quiz_id", "question_id"]
            },
            handler=self.canvas_update_quiz_question
        )
        
        self.tool_registry.register(
            name="canvas_delete_quiz_question",
            description="Delete a quiz question",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "quiz_id": {"type": "number", "description": "ID of the quiz"},
                    "question_id": {"type": "number", "description": "ID of the question"}
                },
                "required": ["course_id", "quiz_id", "question_id"]
            },
            handler=self.canvas_delete_quiz_question
        )
        
        # Rubrics tools
        self.tool_registry.register(
            name="canvas_list_rubrics",
            description="List rubrics for a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_list_rubrics
        )
        
        self.tool_registry.register(
            name="canvas_get_rubric",
            description="Get details of a specific rubric",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "rubric_id": {"type": "number", "description": "ID of the rubric"}
                },
                "required": ["course_id", "rubric_id"]
            },
            handler=self.canvas_get_rubric
        )

        self.tool_registry.register(
            name="canvas_create_rubric",
            description="Create a new rubric in a course",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"},
                    "title": {"type": "string", "description": "Title of the rubric"},
                    "description": {"type": "string", "description": "Description of the rubric"},
                    "free_form_criterion_comments": {"type": "boolean", "description": "Allow free-form comments"},
                    "hide_score_total": {"type": "boolean", "description": "Hide score total"},
                    "criteria": {
                        "type": "array",
                        "description": "Array of criteria for the rubric",
                        "items": {
                            "type": "object",
                            "properties": {
                                "description": {"type": "string", "description": "Criterion description"},
                                "long_description": {"type": "string", "description": "Detailed criterion description"},
                                "points": {"type": "number", "description": "Maximum points for this criterion"},
                                "criterion_use_range": {"type": "boolean", "description": "Use point range"},
                                "ratings": {
                                    "type": "array",
                                    "description": "Array of rating levels for this criterion",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "description": {"type": "string", "description": "Rating description"},
                                            "long_description": {"type": "string", "description": "Detailed rating description"},
                                            "points": {"type": "number", "description": "Points for this rating level"}
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                "required": ["course_id", "title"]
            },
            handler=self.canvas_create_rubric
        )

        # Conversations tools
        self.tool_registry.register(
            name="canvas_list_conversations",
            description="List user's conversations",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.canvas_list_conversations
        )
        
        self.tool_registry.register(
            name="canvas_get_conversation",
            description="Get details of a specific conversation",
            input_schema={
                "type": "object",
                "properties": {
                    "conversation_id": {"type": "number", "description": "ID of the conversation"}
                },
                "required": ["conversation_id"]
            },
            handler=self.canvas_get_conversation
        )
        
        self.tool_registry.register(
            name="canvas_create_conversation",
            description="Create a new conversation",
            input_schema={
                "type": "object",
                "properties": {
                    "recipients": {"type": "array", "items": {"type": "string"}, "description": "Recipient user IDs or email addresses"},
                    "body": {"type": "string", "description": "Message body"},
                    "subject": {"type": "string", "description": "Message subject"}
                },
                "required": ["recipients", "body"]
            },
            handler=self.canvas_create_conversation
        )
        
        # Notifications tools
        self.tool_registry.register(
            name="canvas_list_notifications",
            description="List user's notifications",
            input_schema={"type": "object", "properties": {}, "required": []},
            handler=self.canvas_list_notifications
        )
        
        # Account Management tools
        self.tool_registry.register(
            name="canvas_get_account",
            description="Get account details",
            input_schema={
                "type": "object",
                "properties": {
                    "account_id": {"type": "number", "description": "ID of the account"}
                },
                "required": ["account_id"]
            },
            handler=self.canvas_get_account
        )
        
        self.tool_registry.register(
            name="canvas_list_account_courses",
            description="List courses for an account",
            input_schema={
                "type": "object",
                "properties": {
                    "account_id": {"type": "number", "description": "ID of the account"},
                    "with_enrollments": {"type": "boolean", "description": "Include enrollment data"},
                    "published": {"type": "boolean", "description": "Only include published courses"},
                    "completed": {"type": "boolean", "description": "Include completed courses"},
                    "sort": {"type": "string", "enum": ["course_name", "sis_course_id", "teacher", "account_name"], "description": "Sort order"},
                    "order": {"type": "string", "enum": ["asc", "desc"], "description": "Sort direction"},
                    "search_term": {"type": "string", "description": "Search term to filter courses"}
                },
                "required": ["account_id"]
            },
            handler=self.canvas_list_account_courses
        )
        
        self.tool_registry.register(
            name="canvas_list_account_users",
            description="List users for an account",
            input_schema={
                "type": "object",
                "properties": {
                    "account_id": {"type": "number", "description": "ID of the account"},
                    "sort": {"type": "string", "enum": ["username", "email", "sis_id", "last_login"], "description": "Sort order"},
                    "order": {"type": "string", "enum": ["asc", "desc"], "description": "Sort direction"},
                    "search_term": {"type": "string", "description": "Search term to filter users"}
                },
                "required": ["account_id"]
            },
            handler=self.canvas_list_account_users
        )
        
        self.tool_registry.register(
            name="canvas_create_user",
            description="Create a new user in an account",
            input_schema={
                "type": "object",
                "properties": {
                    "account_id": {"type": "number", "description": "ID of the account"},
                    "user": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Full name of the user"},
                            "short_name": {"type": "string", "description": "Short name of the user"},
                            "sortable_name": {"type": "string", "description": "Sortable name (Last, First)"},
                            "time_zone": {"type": "string", "description": "User's time zone"}
                        },
                        "required": ["name"]
                    },
                    "pseudonym": {
                        "type": "object",
                        "properties": {
                            "unique_id": {"type": "string", "description": "Unique login ID (email or username)"},
                            "password": {"type": "string", "description": "User's password"},
                            "sis_user_id": {"type": "string", "description": "SIS ID for the user"},
                            "send_confirmation": {"type": "boolean", "description": "Send confirmation email"}
                        },
                        "required": ["unique_id"]
                    }
                },
                "required": ["account_id", "user", "pseudonym"]
            },
            handler=self.canvas_create_user
        )
        
        self.tool_registry.register(
            name="canvas_list_sub_accounts",
            description="List sub-accounts for an account",
            input_schema={
                "type": "object",
                "properties": {
                    "account_id": {"type": "number", "description": "ID of the parent account"}
                },
                "required": ["account_id"]
            },
            handler=self.canvas_list_sub_accounts
        )
        
        self.tool_registry.register(
            name="canvas_get_account_reports",
            description="List available reports for an account",
            input_schema={
                "type": "object",
                "properties": {
                    "account_id": {"type": "number", "description": "ID of the account"}
                },
                "required": ["account_id"]
            },
            handler=self.canvas_get_account_reports
        )
        
        self.tool_registry.register(
            name="canvas_create_account_report",
            description="Generate a report for an account",
            input_schema={
                "type": "object",
                "properties": {
                    "account_id": {"type": "number", "description": "ID of the account"},
                    "report": {"type": "string", "description": "Type of report to generate"},
                    "parameters": {"type": "object", "description": "Report parameters"}
                },
                "required": ["account_id", "report"]
            },
            handler=self.canvas_create_account_report
        )
        
        # Additional tools
        self.tool_registry.register(
            name="canvas_get_syllabus",
            description="Get course syllabus",
            input_schema={
                "type": "object",
                "properties": {
                    "course_id": {"type": "number", "description": "ID of the course"}
                },
                "required": ["course_id"]
            },
            handler=self.canvas_get_syllabus
        )
    
    async def list_tools(self):
        """List all available tools"""
        return self.tool_registry.get_tool_definitions()
    
    async def call_tool(self, name: str, arguments: dict):
        """Handle tool calls using the registry"""
        return await self.tool_registry.call_tool(name, arguments)
    
    # Tool handlers
    async def canvas_health_check(self, args: dict):
        """Health check"""
        data = self.db.health_check()
        return self.create_json_response(data)

    # Authentication handlers
    async def canvas_login(self, args: dict):
        """Login user"""
        try:
            login_id = args["login_id"]
            password = args["password"]
            data = self.db.login(login_id, password)
            return self.create_json_response(data)
        except ValueError as e:
            return self.create_text_response(str(e))

    async def canvas_logout(self, args: dict):
        """Logout user"""
        data = self.db.logout()
        return self.create_json_response(data)

    async def canvas_get_current_user(self, args: dict):
        """Get current user"""
        data = self.db.get_current_user()
        return self.create_json_response(data)

    async def canvas_list_users(self, args: dict):
        """List all users"""
        data = self.db.list_users()
        return self.create_json_response(data)
    
    async def canvas_get_user_profile(self, args: dict):
        """Get user profile"""
        data = self.db.get_user_profile()
        if not data:
            return self.create_text_response("User profile not found")
        return self.create_json_response(data)
    
    async def canvas_update_user_profile(self, args: dict):
        """Update user profile"""
        data = self.db.update_user_profile(self.db.current_user_id, args)
        if not data:
            return self.create_text_response("Failed to update user profile")
        return self.create_json_response(data)
    
    async def canvas_list_courses(self, args: dict):
        """List courses"""
        include_ended = args.get("include_ended", False)
        data = self.db.list_courses(include_ended=include_ended)
        return self.create_json_response(data)
    
    async def canvas_get_course(self, args: dict):
        """Get course details"""
        course_id = args["course_id"]
        data = self.db.get_course(course_id)
        if not data:
            return self.create_text_response(f"Course not found: {course_id}")
        return self.create_json_response(data)
    
    async def canvas_create_course(self, args: dict):
        """Create course"""
        account_id = args.pop("account_id")
        data = self.db.create_course(account_id, args)
        return self.create_json_response(data)
    
    async def canvas_update_course(self, args: dict):
        """Update course"""
        course_id = args.pop("course_id")
        data = self.db.update_course(course_id, args)
        if not data:
            return self.create_text_response(f"Course not found: {course_id}")
        return self.create_json_response(data)
    
    async def canvas_list_assignments(self, args: dict):
        """List assignments"""
        course_id = args["course_id"]
        data = self.db.list_assignments(course_id)
        return self.create_json_response(data)
    
    async def canvas_get_assignment(self, args: dict):
        """Get assignment details"""
        course_id = args["course_id"]
        assignment_id = args["assignment_id"]
        data = self.db.get_assignment(course_id, assignment_id)
        if not data:
            return self.create_text_response(f"Assignment not found: {assignment_id} in course {course_id}")
        return self.create_json_response(data)
    
    async def canvas_create_assignment(self, args: dict):
        """Create assignment"""
        course_id = args.pop("course_id")
        data = self.db.create_assignment(course_id, args)
        return self.create_json_response(data)
    
    async def canvas_update_assignment(self, args: dict):
        """Update assignment"""
        course_id = args.pop("course_id")
        assignment_id = args.pop("assignment_id")
        data = self.db.update_assignment(course_id, assignment_id, args)
        if not data:
            return self.create_text_response(f"Assignment not found: {assignment_id} in course {course_id}")
        return self.create_json_response(data)
    
    async def canvas_get_submission(self, args: dict):
        """Get submission"""
        course_id = args["course_id"]
        assignment_id = args["assignment_id"]
        user_id = args.get("user_id")
        data = self.db.get_submission(course_id, assignment_id, user_id)
        if not data:
            return self.create_text_response(f"No submission found for assignment {assignment_id}")
        return self.create_json_response(data)
    
    async def canvas_submit_assignment(self, args: dict):
        """Submit assignment"""
        course_id = args.pop("course_id")
        assignment_id = args.pop("assignment_id")
        data = self.db.submit_assignment(course_id, assignment_id, args)
        return self.create_json_response(data)
    
    async def canvas_submit_grade(self, args: dict):
        """Submit grade"""
        course_id = args["course_id"]
        assignment_id = args["assignment_id"]
        user_id = args["user_id"]
        grade = args["grade"]
        comment = args.get("comment")
        
        data = self.db.submit_grade(course_id, assignment_id, user_id, grade, comment)
        if not data:
            return self.create_text_response(f"Submission not found for user {user_id} on assignment {assignment_id}")
        return self.create_json_response(data)
    
    # Files & Folders handlers
    async def canvas_list_files(self, args: dict):
        """List files"""
        course_id = args["course_id"]
        folder_id = args.get("folder_id")
        data = self.db.list_files(course_id, folder_id)
        return self.create_json_response(data)
    
    async def canvas_get_file(self, args: dict):
        """Get file"""
        file_id = args["file_id"]
        data = self.db.get_file(file_id)
        if not data:
            return self.create_text_response(f"File not found: {file_id}")
        return self.create_json_response(data)
    
    async def canvas_list_folders(self, args: dict):
        """List folders"""
        course_id = args["course_id"]
        data = self.db.list_folders(course_id)
        return self.create_json_response(data)
    
    # Pages handlers
    async def canvas_list_pages(self, args: dict):
        """List pages"""
        course_id = args["course_id"]
        data = self.db.list_pages(course_id)
        return self.create_json_response(data)
    
    async def canvas_get_page(self, args: dict):
        """Get page"""
        course_id = args["course_id"]
        page_url = args["page_url"]
        data = self.db.get_page(course_id, page_url)
        if not data:
            return self.create_text_response(f"Page not found: {page_url} in course {course_id}")
        return self.create_json_response(data)
    
    # Calendar & Dashboard handlers
    async def canvas_list_calendar_events(self, args: dict):
        """List calendar events"""
        start_date = args.get("start_date")
        end_date = args.get("end_date")
        data = self.db.list_calendar_events(start_date, end_date)
        return self.create_json_response(data)
    
    async def canvas_get_upcoming_assignments(self, args: dict):
        """Get upcoming assignments"""
        limit = args.get("limit", 10)
        data = self.db.get_upcoming_assignments(limit)
        return self.create_json_response(data)
    
    async def canvas_get_dashboard(self, args: dict):
        """Get dashboard"""
        data = self.db.get_dashboard()
        return self.create_json_response(data)
    
    async def canvas_get_dashboard_cards(self, args: dict):
        """Get dashboard cards"""
        data = self.db.get_dashboard_cards()
        return self.create_json_response(data)
    
    # Grades handlers
    async def canvas_get_course_grades(self, args: dict):
        """Get course grades"""
        course_id = args["course_id"]
        data = self.db.get_course_grades(course_id)
        return self.create_json_response(data)
    
    async def canvas_get_user_grades(self, args: dict):
        """Get user grades"""
        data = self.db.get_user_grades()
        return self.create_json_response(data)
    
    # Enrollment handlers
    async def canvas_enroll_user(self, args: dict):
        """Enroll user"""
        course_id = args["course_id"]
        user_id = args["user_id"]
        role = args.get("role", "StudentEnrollment")
        enrollment_state = args.get("enrollment_state", "active")
        data = self.db.enroll_user(course_id, user_id, role, enrollment_state)
        return self.create_json_response(data)
    
    # Modules handlers
    async def canvas_list_modules(self, args: dict):
        """List modules"""
        course_id = args["course_id"]
        data = self.db.list_modules(course_id)
        return self.create_json_response(data)
    
    async def canvas_get_module(self, args: dict):
        """Get module"""
        course_id = args["course_id"]
        module_id = args["module_id"]
        data = self.db.get_module(course_id, module_id)
        if not data:
            return self.create_text_response(f"Module not found: {module_id} in course {course_id}")
        return self.create_json_response(data)
    
    async def canvas_list_module_items(self, args: dict):
        """List module items"""
        course_id = args["course_id"]
        module_id = args["module_id"]
        data = self.db.list_module_items(course_id, module_id)
        return self.create_json_response(data)
    
    async def canvas_get_module_item(self, args: dict):
        """Get module item"""
        course_id = args["course_id"]
        module_id = args["module_id"]
        item_id = args["item_id"]
        data = self.db.get_module_item(course_id, module_id, item_id)
        if not data:
            return self.create_text_response(f"Module item not found: {item_id} in module {module_id}")
        return self.create_json_response(data)
    
    async def canvas_mark_module_item_complete(self, args: dict):
        """Mark module item complete"""
        course_id = args["course_id"]
        module_id = args["module_id"]
        item_id = args["item_id"]
        data = self.db.mark_module_item_complete(course_id, module_id, item_id)
        if not data:
            return self.create_text_response(f"Module item not found: {item_id} in module {module_id}")
        return self.create_json_response(data)

    async def canvas_create_module(self, args: dict):
        """Create module"""
        course_id = args.pop("course_id")
        data = self.db.create_module(course_id, args)
        return self.create_json_response(data)

    async def canvas_create_module_item(self, args: dict):
        """Create module item"""
        course_id = args.pop("course_id")
        module_id = args.pop("module_id")
        data = self.db.create_module_item(course_id, module_id, args)
        if not data:
            return self.create_text_response(f"Module not found: {module_id} in course {course_id}")
        return self.create_json_response(data)

    # Discussions handlers
    async def canvas_list_discussion_topics(self, args: dict):
        """List discussion topics"""
        course_id = args["course_id"]
        data = self.db.list_discussion_topics(course_id)
        return self.create_json_response(data)
    
    async def canvas_get_discussion_topic(self, args: dict):
        """Get discussion topic"""
        course_id = args["course_id"]
        topic_id = args["topic_id"]
        data = self.db.get_discussion_topic(course_id, topic_id)
        if not data:
            return self.create_text_response(f"Discussion topic not found: {topic_id} in course {course_id}")
        return self.create_json_response(data)
    
    async def canvas_post_to_discussion(self, args: dict):
        """Post to discussion"""
        course_id = args["course_id"]
        topic_id = args["topic_id"]
        message = args["message"]
        data = self.db.post_to_discussion(course_id, topic_id, message)
        return self.create_json_response(data)
    
    # Announcements handlers
    async def canvas_list_announcements(self, args: dict):
        """List announcements"""
        course_id = args["course_id"]
        data = self.db.list_announcements(course_id)
        return self.create_json_response(data)
    
    # Quizzes handlers
    async def canvas_list_quizzes(self, args: dict):
        """List quizzes"""
        course_id = args["course_id"]
        data = self.db.list_quizzes(course_id)
        return self.create_json_response(data)
    
    async def canvas_get_quiz(self, args: dict):
        """Get quiz"""
        course_id = args["course_id"]
        quiz_id = args["quiz_id"]
        data = self.db.get_quiz(course_id, quiz_id)
        if not data:
            return self.create_text_response(f"Quiz not found: {quiz_id} in course {course_id}")
        return self.create_json_response(data)
    
    async def canvas_create_quiz(self, args: dict):
        """Create quiz"""
        course_id = args.pop("course_id")
        data = self.db.create_quiz(course_id, args)
        return self.create_json_response(data)
    
    async def canvas_start_quiz_attempt(self, args: dict):
        """Start quiz attempt"""
        course_id = args["course_id"]
        quiz_id = args["quiz_id"]
        data = self.db.start_quiz_attempt(course_id, quiz_id)
        return self.create_json_response(data)
    
    async def canvas_update_quiz(self, args: dict):
        """Update quiz"""
        course_id = args.pop("course_id")
        quiz_id = args.pop("quiz_id")
        data = self.db.update_quiz(course_id, quiz_id, args)
        if not data:
            return self.create_text_response(f"Quiz not found: {quiz_id} in course {course_id}")
        return self.create_json_response(data)
    
    async def canvas_publish_quiz(self, args: dict):
        """Publish quiz"""
        course_id = args["course_id"]
        quiz_id = args["quiz_id"]
        data = self.db.publish_quiz(course_id, quiz_id)
        if not data:
            return self.create_text_response(f"Quiz not found: {quiz_id} in course {course_id}")
        return self.create_json_response(data)
    
    async def canvas_delete_quiz(self, args: dict):
        """Delete quiz"""
        course_id = args["course_id"]
        quiz_id = args["quiz_id"]
        success = self.db.delete_quiz(course_id, quiz_id)
        if success:
            return self.create_text_response(f"Quiz {quiz_id} deleted successfully")
        else:
            return self.create_text_response(f"Failed to delete quiz {quiz_id}")
    
    async def canvas_add_quiz_question(self, args: dict):
        """Add quiz question"""
        course_id = args.pop("course_id")
        quiz_id = args.pop("quiz_id")
        data = self.db.add_quiz_question(course_id, quiz_id, args)
        if not data:
            return self.create_text_response(f"Quiz not found: {quiz_id} in course {course_id}")
        return self.create_json_response(data)
    
    async def canvas_get_quiz_questions(self, args: dict):
        """Get quiz questions"""
        course_id = args["course_id"]
        quiz_id = args["quiz_id"]
        data = self.db.get_quiz_questions(course_id, quiz_id)
        return self.create_json_response(data)
    
    async def canvas_update_quiz_question(self, args: dict):
        """Update quiz question"""
        course_id = args.pop("course_id")
        quiz_id = args.pop("quiz_id")
        question_id = args.pop("question_id")
        data = self.db.update_quiz_question(course_id, quiz_id, question_id, args)
        if not data:
            return self.create_text_response(f"Question not found: {question_id} in quiz {quiz_id}")
        return self.create_json_response(data)
    
    async def canvas_delete_quiz_question(self, args: dict):
        """Delete quiz question"""
        course_id = args["course_id"]
        quiz_id = args["quiz_id"]
        question_id = args["question_id"]
        success = self.db.delete_quiz_question(course_id, quiz_id, question_id)
        if success:
            return self.create_text_response(f"Question {question_id} deleted successfully")
        else:
            return self.create_text_response(f"Failed to delete question {question_id}")
    
    # Rubrics handlers
    async def canvas_list_rubrics(self, args: dict):
        """List rubrics"""
        course_id = args["course_id"]
        data = self.db.list_rubrics(course_id)
        return self.create_json_response(data)
    
    async def canvas_get_rubric(self, args: dict):
        """Get rubric"""
        course_id = args["course_id"]
        rubric_id = args["rubric_id"]
        data = self.db.get_rubric(course_id, rubric_id)
        if not data:
            return self.create_text_response(f"Rubric not found: {rubric_id} in course {course_id}")
        return self.create_json_response(data)

    async def canvas_create_rubric(self, args: dict):
        """Create rubric"""
        course_id = args.pop("course_id")
        data = self.db.create_rubric(course_id, args)
        return self.create_json_response(data)

    # Conversations handlers
    async def canvas_list_conversations(self, args: dict):
        """List conversations"""
        data = self.db.list_conversations()
        return self.create_json_response(data)
    
    async def canvas_get_conversation(self, args: dict):
        """Get conversation"""
        conversation_id = args["conversation_id"]
        data = self.db.get_conversation(conversation_id)
        if not data:
            return self.create_text_response(f"Conversation not found: {conversation_id}")
        return self.create_json_response(data)
    
    async def canvas_create_conversation(self, args: dict):
        """Create conversation"""
        recipients = args["recipients"]
        body = args["body"]
        subject = args.get("subject")
        data = self.db.create_conversation(recipients, body, subject)
        return self.create_json_response(data)
    
    # Notifications handlers
    async def canvas_list_notifications(self, args: dict):
        """List notifications"""
        data = self.db.list_notifications()
        return self.create_json_response(data)
    
    # Account handlers
    async def canvas_get_account(self, args: dict):
        """Get account"""
        account_id = args["account_id"]
        data = self.db.get_account(account_id)
        if not data:
            return self.create_text_response(f"Account not found: {account_id}")
        return self.create_json_response(data)
    
    async def canvas_list_account_courses(self, args: dict):
        """List account courses"""
        account_id = args["account_id"]
        data = self.db.list_account_courses(account_id, **args)
        return self.create_json_response(data)
    
    async def canvas_list_account_users(self, args: dict):
        """List account users"""
        account_id = args["account_id"]
        data = self.db.list_account_users(account_id, **args)
        return self.create_json_response(data)
    
    async def canvas_create_user(self, args: dict):
        """Create user"""
        account_id = args["account_id"]
        user_data = args["user"]
        pseudonym_data = args["pseudonym"]
        data = self.db.create_user(account_id, user_data, pseudonym_data)
        return self.create_json_response(data)
    
    async def canvas_list_sub_accounts(self, args: dict):
        """List sub accounts"""
        account_id = args["account_id"]
        data = self.db.list_sub_accounts(account_id)
        return self.create_json_response(data)
    
    async def canvas_get_account_reports(self, args: dict):
        """Get account reports"""
        account_id = args["account_id"]
        data = self.db.get_account_reports(account_id)
        return self.create_json_response(data)
    
    async def canvas_create_account_report(self, args: dict):
        """Create account report"""
        account_id = args["account_id"]
        report_type = args["report"]
        parameters = args.get("parameters", {})
        data = self.db.create_account_report(account_id, report_type, parameters)
        return self.create_json_response(data)
    
    async def canvas_get_syllabus(self, args: dict):
        """Get syllabus"""
        course_id = args["course_id"]
        data = self.db.get_syllabus(course_id)
        if not data:
            return self.create_text_response(f"Syllabus not found for course: {course_id}")
        return self.create_json_response(data)


async def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(description='Canvas MCP Server')
    parser.add_argument('--login_id', type=str, help='Canvas login ID for auto-login')
    parser.add_argument('--password', type=str, help='Canvas password for auto-login')
    args = parser.parse_args()

    server = CanvasMCPServer(login_id=args.login_id, password=args.password)
    await server.run()


if __name__ == "__main__":
    asyncio.run(main())
