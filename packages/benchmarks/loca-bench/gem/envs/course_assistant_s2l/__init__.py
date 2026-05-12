"""
Course Assistant S2L Environment

This environment simulates a teaching assistant scenario where an AI agent needs to:
1. Check student assignment submission status from emails
2. Identify students who have not submitted (excluding dropped students)
3. Send personalized reminder emails to each student who needs to submit

The task tests the agent's ability to:
- Read and parse structured data (Excel files)
- Process email communications
- Perform conditional logic based on student status
- Send targeted, personalized emails

Author: Adapted from course-assistant-s2l task
Version: 1.0
"""

from .course_assistant_s2l import CourseAssistantS2LEnv

__all__ = ["CourseAssistantS2LEnv"]



