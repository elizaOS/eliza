#!/usr/bin/env python3
"""
Script to extract quiz information from course_config.json and save to CSV.
"""

import json
import csv
from datetime import datetime
from pathlib import Path

def parse_quiz_data(json_file_path, output_csv_path):
    """Extract quiz information from course_config.json and save to CSV."""

    # Read the JSON file
    with open(json_file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    quiz_data = []

    for course in data['courses']:
        # if course_code == "ENG101-1":
        #     continue
        quiz = course.get('quiz', {})
        if not quiz:
            continue

        # Extract basic course info
        course_code = course.get('course_code', '')

        if course_code == "ENG101-1":
            continue
        course_name = course.get('name', '')
        course_name = course_name.strip('-')[:-2]

        credits = course.get('credits', '')

        # Extract quiz info
        quiz_title = quiz.get('title', '')
        time_limit = quiz.get('time_limit', '')
        allowed_attempts = quiz.get('allowed_attempts', '')
        scoring_policy = quiz.get('scoring_policy', '')
        points_possible = quiz.get('points_possible', '')
        deadline = quiz.get('due_at', '')

        # Count number of questions
        questions = quiz.get('questions', [])
        number_of_questions = len(questions)

        # Parse deadline for sorting
        deadline_dt = None
        if deadline:
            try:
                deadline_dt = datetime.fromisoformat(deadline.replace('Z', '+00:00'))
            except ValueError:
                deadline_dt = None

        quiz_data.append({
            'course_code': course_code,

            'credits': credits,
            'quiz_title': quiz_title,
            'number_of_questions': number_of_questions,
            'time_limit': time_limit,
            'allowed_attempts': allowed_attempts,
            'scoring_policy': scoring_policy,
            'points_possible': points_possible,
            'deadline': deadline,
            'course_name': course_name,
            'deadline_parsed': deadline_dt
        })

    # Sort by deadline (earliest first), then by course_code
    quiz_data.sort(key=lambda x: (x['deadline_parsed'] or datetime.max, x['course_code']))

    # Write to CSV
    fieldnames = [
        'course_code' , 'course_name',   'credits', 'quiz_title', 'number_of_questions',
        'time_limit', 'allowed_attempts', 'scoring_policy', 'points_possible',
        'deadline',
    ]

    with open(output_csv_path, 'w', newline='', encoding='utf-8') as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        writer.writeheader()

        for row in quiz_data:
            # Remove the helper field before writing
            row_copy = {k: v for k, v in row.items() if k != 'deadline_parsed'}
            writer.writerow(row_copy)

    print(f"Quiz information extracted successfully!")
    print(f"Total quizzes found: {len(quiz_data)}")
    print(f"CSV file saved to: {output_csv_path}")

    return len(quiz_data)

def parse_assign_data(json_file_path, output_csv_path):
    """Extract assignment information from course_config.json and save to CSV."""

    # Read the JSON file
    with open(json_file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    assign_data = []

    for course in data['courses']:
        assign = course.get('assignment', {})
        if not assign:
            continue

        # Extract basic course info
        course_code = course.get('course_code', '')
        ### Assignments for these two courses have been submitted, no need to count them ###
        if course_code == "CS101-1" or course_code == "CS201-1":
            continue
        course_name = course.get('name', '')
        course_name = course_name.strip('-')[:-2]


        # Extract assignment info
        assign_title = assign.get('name', '')

        deadline = assign.get('due_at', '')

        # Count number of questions
        description = assign.get('description', [])
        points_possible = assign.get('points_possible', [])

        # Parse deadline for sorting
        deadline_dt = None
        if deadline:
            try:
                deadline_dt = datetime.fromisoformat(deadline.replace('Z', '+00:00'))
            except ValueError:
                deadline_dt = None

        assign_data.append({
            'course_code': course_code,
            'course_name': course_name,

            'assignment_title': assign_title,
            'description': description,


            'deadline': deadline,  # Keep original string format
            'deadline_parsed': deadline_dt,  # Add parsed version for sorting

             'points_possible': points_possible,


        })

    # Sort by deadline (earliest first), then by course_code
    assign_data.sort(key=lambda x: (x['deadline_parsed'] or datetime.max, x['course_code']))

    # Write to CSV
    fieldnames = [
        'course_code',  'assignment_title', 'description',
        'deadline', 'course_name', 'points_possible'

    ]

    with open(output_csv_path, 'w', newline='', encoding='utf-8') as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        writer.writeheader()

        for row in assign_data:
            # Remove the helper field before writing
            row_copy = {k: v for k, v in row.items() if k != 'deadline_parsed'}
            writer.writerow(row_copy)

    print(f"Assignment information extracted successfully!")
    print(f"Total assignments found: {len(assign_data)}")
    print(f"CSV file saved to: {output_csv_path}")

    return len(assign_data)

def main():
    """Main function to run the script."""

    script_dir = Path(__file__).parent.parent
    json_file_path = script_dir / 'files' / 'course_config.json'
    output_csv_path = script_dir / 'groundtruth_workspace' / 'quiz_info.csv'
    output_csv_path2 = script_dir / 'groundtruth_workspace' / 'assignment_info.csv'

    # Check if input file exists
    if not Path(json_file_path).exists():
        print(f"Error: Input file not found: {json_file_path}")
        return

    try:
        quiz_count = parse_quiz_data(json_file_path, output_csv_path)
        assign_count = parse_assign_data(json_file_path, output_csv_path2)

        # Display summary
        print("\n" + "="*50)
        print("EXTRACTION SUMMARY")
        print("="*50)
        print(f"Input file: {json_file_path}")
        print(f"Quiz output file: {output_csv_path}")
        print(f"Assignment output file: {output_csv_path2}")
        print(f"Total quizzes extracted: {quiz_count}")
        print(f"Total assignments extracted: {assign_count}")

    except Exception as e:
        print(f"Error processing files: {str(e)}")

if __name__ == "__main__":
    main()
