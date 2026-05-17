"""
Academic Warning S2L Environment

This environment simulates an educational scenario where an agent needs to:
1. Query historical exam data from BigQuery (tables exam_2501 to exam_2507)
2. Read latest quiz scores from an Excel/CSV file
3. Calculate each student's historical average
4. Identify students with >25% score drop
5. Save at-risk students to bad_student.csv
6. Write CRITICAL logs for students with >45% drop

The task tests the agent's ability to:
- Work with BigQuery datasets and multiple tables
- Perform data analysis and calculations
- Handle educational data processing requirements
- Write structured logs to Cloud Logging
"""

from .academic_warning_s2l import AcademicWarningS2LEnv

__all__ = ["AcademicWarningS2LEnv"]

