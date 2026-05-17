# Simplified Canvas MCP Server

A Model Context Protocol server that provides Canvas LMS functionality using local JSON files as the database instead of connecting to external Canvas APIs.

## Features

This simplified Canvas MCP server provides the following functionality:

### User Management
- Get user profile
- Update user profile

### Course Management
- List courses
- Get course details
- Create courses
- Update courses

### Assignment Management
- List assignments for courses
- Get assignment details
- Create assignments
- Update assignments

### Submission Management
- Get submission details
- Submit assignments
- Grade submissions

### System
- Health check

## Data Structure

The server uses local JSON files to simulate Canvas data:

- `data/users.json` - User profiles and information
- `data/courses.json` - Course details and configurations
- `data/assignments.json` - Assignment specifications and metadata
- `data/enrollments.json` - User enrollment data for courses
- `data/submissions.json` - Student submissions and grades

## Configuration

The server is configured via `configs/mcp_servers/canvas.yaml`:

```yaml
type: stdio
name: canvas
params:
  command: uv
  args:
    - "--directory"
    - "${project_root}/mcp-convert/mcps/canvas"
    - "run"
    - "python"
    - "server.py"
  env:
    # Database directory - automatically initialized if not present
    CANVAS_DATA_DIR: "${agent_workspace}/../canvas-db"
```

### Database Initialization

The database is **automatically initialized** when the server starts if it doesn't exist. It creates:

- **Default Users (8 total):**
  - **Administrator:** Jennifer Martinez (`login="admin"`, `password="admin123"`)
  - **Teachers:**
    - Dr. Robert Chen (`login="robert.chen"`, `password="teacher123"`)
    - Prof. Sarah Johnson (`login="sarah.johnson"`, `password="teacher123"`)
  - **Students:**
    - Michael Thompson (`login="michael.thompson"`, `password="student123"`)
    - Emily Rodriguez (`login="emily.rodriguez"`, `password="student123"`)
    - James Wilson (`login="james.wilson"`, `password="student123"`)
    - Sophia Patel (`login="sophia.patel"`, `password="student123"`)
    - Daniel Kim (`login="daniel.kim"`, `password="student123"`)
- **Default Institution:** Account ID 1, Name "Default Institution"
- **Empty data files** for courses, assignments, quizzes, etc.

### Auto-Login Support

You can configure the server to automatically log in as a specific user:

```yaml
params:
  command: uv
  args:
    - "--directory"
    - "${project_root}/mcp-convert/mcps/canvas"
    - "run"
    - "python"
    - "server.py"
    - "--login_id"
    - "michael.thompson"
    - "--password"
    - "student123"
```

### Per-Task Database

Each task can have its own isolated database by specifying a different path:

```yaml
env:
  CANVAS_DATA_DIR: "${agent_workspace}/task-canvas-db"
```

### Manual Database Initialization

You can manually initialize a database directory:

```bash
# Initialize in default location
cd mcp-convert/mcps/canvas
python init_database.py

# Initialize in custom location
python init_database.py --data-dir /path/to/database

# Force re-initialization
python init_database.py --force --data-dir /path/to/database
```

## Testing & Development

### Running the Server

```bash
# Run server with default configuration
cd mcp-convert/mcps/canvas
uv run python server.py

# Run with auto-login as a student
uv run python server.py --login_id michael.thompson --password student123

# Run with auto-login as a teacher
uv run python server.py --login_id robert.chen --password teacher123
```

### Running Tests

Run the test suite to verify functionality:

```bash
uv run pytest mcps/canvas/test_server.py -v
```

## Available Tools

The server provides **50+ MCP tools** covering all major Canvas LMS functionality:

### System & Health
1. **canvas_health_check** - Check server health and connectivity

### User Management
2. **canvas_get_user_profile** - Get current user's profile
3. **canvas_update_user_profile** - Update current user's profile

### Course Management
4. **canvas_list_courses** - List all courses for current user
5. **canvas_get_course** - Get detailed course information
6. **canvas_create_course** - Create a new course
7. **canvas_update_course** - Update existing course
8. **canvas_get_syllabus** - Get course syllabus

### Assignment Management
9. **canvas_list_assignments** - List assignments for a course
10. **canvas_get_assignment** - Get detailed assignment information
11. **canvas_create_assignment** - Create a new assignment
12. **canvas_update_assignment** - Update existing assignment

### Submission Management
13. **canvas_get_submission** - Get submission details
14. **canvas_submit_assignment** - Submit work for an assignment
15. **canvas_submit_grade** - Grade a student's assignment (teacher only)

### Files & Folders
16. **canvas_list_files** - List files in a course or folder
17. **canvas_get_file** - Get information about a specific file
18. **canvas_list_folders** - List folders in a course

### Pages
19. **canvas_list_pages** - List pages in a course
20. **canvas_get_page** - Get content of a specific page

### Calendar & Dashboard
21. **canvas_list_calendar_events** - List calendar events
22. **canvas_get_upcoming_assignments** - Get upcoming assignment due dates
23. **canvas_get_dashboard** - Get user's dashboard information
24. **canvas_get_dashboard_cards** - Get dashboard course cards

### Grades
25. **canvas_get_course_grades** - Get grades for a course
26. **canvas_get_user_grades** - Get all grades for the current user

### Enrollment
27. **canvas_enroll_user** - Enroll a user in a course

### Modules
28. **canvas_list_modules** - List all modules in a course
29. **canvas_get_module** - Get details of a specific module
30. **canvas_list_module_items** - List all items in a module
31. **canvas_get_module_item** - Get details of a specific module item
32. **canvas_mark_module_item_complete** - Mark a module item as complete

### Discussions
33. **canvas_list_discussion_topics** - List all discussion topics in a course
34. **canvas_get_discussion_topic** - Get details of a specific discussion topic
35. **canvas_post_to_discussion** - Post a message to a discussion topic

### Announcements
36. **canvas_list_announcements** - List all announcements in a course

### Quizzes
37. **canvas_list_quizzes** - List all quizzes in a course
38. **canvas_get_quiz** - Get details of a specific quiz
39. **canvas_create_quiz** - Create a new quiz in a course
40. **canvas_start_quiz_attempt** - Start a new quiz attempt

### Rubrics
41. **canvas_list_rubrics** - List rubrics for a course
42. **canvas_get_rubric** - Get details of a specific rubric

### Conversations
43. **canvas_list_conversations** - List user's conversations
44. **canvas_get_conversation** - Get details of a specific conversation
45. **canvas_create_conversation** - Create a new conversation

### Notifications
46. **canvas_list_notifications** - List user's notifications

### Account Management
47. **canvas_get_account** - Get account details
48. **canvas_list_account_courses** - List courses for an account
49. **canvas_list_account_users** - List users for an account
50. **canvas_create_user** - Create a new user in an account
51. **canvas_list_sub_accounts** - List sub-accounts for an account
52. **canvas_get_account_reports** - List available reports for an account
53. **canvas_create_account_report** - Generate a report for an account

## Sample Data

The server comes with sample data including:
- Admin user (ID: 534)
- Student user (ID: 535) 
- Teacher user (ID: 536)
- Introduction to Computer Science course (CS101)
- Advanced Web Development course (WEB301)
- Sample assignments and submissions

This provides a realistic Canvas environment for testing and development without requiring a live Canvas instance.