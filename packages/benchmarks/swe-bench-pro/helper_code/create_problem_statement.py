"""
Utilities for creating and formatting problem statements from the SWE-bench Pro dataset.

This module provides functions to format problem statements using the template
that includes the problem statement, requirements, and new interfaces.

The SWE-bench Pro dataset contains:
- problem_statement: The main issue description
- requirements: Requirements for the solution
- interface: New interfaces introduced
"""


def create_problem_statement(row):
    problem_statement = row['problem_statement']
    requirement = row['requirements']
    interface = row['interface']
    
    return f"""{problem_statement}

Requirements:
{requirement}

New interfaces introduced:
{interface}"""
