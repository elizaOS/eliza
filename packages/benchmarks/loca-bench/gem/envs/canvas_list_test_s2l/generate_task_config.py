#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Canvas List Test Task Configuration Generator
Dynamically generates task configurations with different difficulty levels
"""

import json
import random
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any, Tuple
import argparse


class TaskConfigGenerator:
    """Task Configuration Generator"""

    # Course template library (expanded to 55 courses)
    COURSE_TEMPLATES = {
        "CS": [
            {"name": "Introduction to Computer Science", "code": "CS101", "credits": 3},
            {"name": "Data Structures and Algorithms", "code": "CS201", "credits": 4},
            {"name": "Database Systems", "code": "CS301", "credits": 4},
            {"name": "Software Engineering Practice", "code": "CS302", "credits": 3},
            {"name": "Software Engineering", "code": "CS401", "credits": 4},
            {"name": "Operating Systems", "code": "CS303", "credits": 4},
            {"name": "Computer Networks", "code": "CS304", "credits": 3},
            {"name": "Compiler Design", "code": "CS402", "credits": 4},
            {"name": "Web Development", "code": "CS202", "credits": 3},
            {"name": "Mobile Application Development", "code": "CS305", "credits": 3},
            {"name": "Computer Graphics", "code": "CS403", "credits": 3},
            {"name": "Parallel Computing", "code": "CS404", "credits": 3},
            {"name": "Computer Architecture", "code": "CS405", "credits": 4},
            {"name": "Algorithm Analysis", "code": "CS406", "credits": 3},
            {"name": "Theory of Computation", "code": "CS407", "credits": 3},
        ],
        "AI": [
            {"name": "Fundamentals of Artificial Intelligence", "code": "AI101", "credits": 3},
            {"name": "Machine Learning", "code": "AI201", "credits": 4},
            {"name": "Deep Learning", "code": "AI301", "credits": 4},
            {"name": "Computer Vision", "code": "AI302", "credits": 3},
            {"name": "Natural Language Processing", "code": "NLP101", "credits": 3},
            {"name": "Reinforcement Learning", "code": "AI303", "credits": 4},
            {"name": "Data Mining", "code": "AI304", "credits": 3},
            {"name": "Statistical Learning", "code": "AI305", "credits": 3},
        ],
        "MATH": [
            {"name": "Linear Algebra", "code": "MATH101", "credits": 3},
            {"name": "Advanced Mathematics", "code": "MATH201", "credits": 4},
            {"name": "Probability and Statistics", "code": "MATH202", "credits": 3},
            {"name": "Discrete Mathematics", "code": "MATH102", "credits": 3},
            {"name": "Numerical Analysis", "code": "MATH301", "credits": 4},
            {"name": "Calculus I", "code": "MATH103", "credits": 4},
            {"name": "Calculus II", "code": "MATH104", "credits": 4},
            {"name": "Mathematical Modeling", "code": "MATH302", "credits": 3},
        ],
        "DB": [
            {"name": "Database Systems Fundamentals", "code": "DB101", "credits": 2},
            {"name": "Advanced Database Systems", "code": "DB201", "credits": 3},
            {"name": "Big Data Technologies", "code": "DB301", "credits": 4},
            {"name": "Data Warehousing", "code": "DB302", "credits": 3},
            {"name": "Big Data Analytics", "code": "DB401", "credits": 4},
        ],
        "NET": [
            {"name": "Network Programming", "code": "NET101", "credits": 3},
            {"name": "Network Security", "code": "NET201", "credits": 3},
            {"name": "Cloud Computing", "code": "NET301", "credits": 4},
            {"name": "Distributed Systems", "code": "NET302", "credits": 4},
            {"name": "Full Stack Development", "code": "WEB301", "credits": 4},
            {"name": "Backend Development", "code": "WEB302", "credits": 3},
        ],
        "SEC": [
            {"name": "Information Security", "code": "SEC101", "credits": 4},
            {"name": "Cryptography", "code": "SEC201", "credits": 4},
            {"name": "Cybersecurity", "code": "SEC301", "credits": 3},
        ],
        "OTHER": [
            {"name": "English Foundation", "code": "ENG101", "credits": 1},
            {"name": "Modern European History", "code": "HIST301", "credits": 4},
            {"name": "Critical Thinking and Logic", "code": "PHIL201", "credits": 3},
            {"name": "Business Communication", "code": "BUS101", "credits": 2},
            {"name": "Psychology", "code": "PSY101", "credits": 3},
            {"name": "Human Computer Interaction", "code": "HCI301", "credits": 3},
            {"name": "Software Testing", "code": "SE301", "credits": 3},
            {"name": "Project Management", "code": "PM201", "credits": 2},
            {"name": "Technical Writing", "code": "TW101", "credits": 2},
            {"name": "Ethics in Computing", "code": "ETH201", "credits": 2},
            {"name": "Embedded Systems", "code": "EMB301", "credits": 4},
        ]
    }

    # Teacher email pool
    TEACHER_EMAILS = [
        "stephenb@mcp.com",
        "brandonr@mcp.com",
        "richardl@mcp.com",
        "jenniferj31@mcp.com",
        "smith@mcp.com",
        "johnson@mcp.com",
        "williams@mcp.com",
    ]

    # Exam types
    EXAM_TYPES = ["closed_book", "open_book", "no_exam"]

    # Buildings and rooms
    BUILDINGS = ["A", "B", "C", "D"]

    def __init__(self, seed: int = 42):
        """Initialize the generator"""
        random.seed(seed)
        self.current_date = datetime.now()

    def generate_student_users(self, num_students: int) -> List[Dict[str, Any]]:
        """Generate list of student users"""
        users = []

        # First student must be Ryan Brown (the protagonist of the task)
        users.append({
            "id": 14,
            "first_name": "Ryan",
            "last_name": "Brown",
            "full_name": "Ryan Brown",
            "email": "ryan.brown93@mcp.com",
            "password": "BryapivvLK7C"
        })

        # Generate other students
        first_names = ["Jacob", "Christine", "Emily", "Michael", "Sarah",
                      "David", "Jessica", "James", "Ashley", "Robert", "Amanda",
                      "Daniel", "Jennifer", "Matthew", "Lisa", "Christopher", "Karen"]
        last_names = ["Flores", "Hall", "Smith", "Johnson", "Williams",
                     "Jones", "Davis", "Miller", "Wilson", "Moore", "Taylor",
                     "Anderson", "Thomas", "Jackson", "White", "Harris", "Martin"]

        used_emails = {"ryan.brown93@mcp.com"}

        for i in range(1, num_students):
            first = random.choice(first_names)
            last = random.choice(last_names)

            # Generate unique email
            email_base = f"{first.lower()}.{last.lower()}"
            email = f"{email_base}{random.randint(1, 99)}@mcp.com"
            while email in used_emails:
                email = f"{email_base}{random.randint(1, 99)}@mcp.com"
            used_emails.add(email)

            # Generate random password
            password = ''.join(random.choices('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', k=12))

            users.append({
                "id": 14 + i,
                "first_name": first,
                "last_name": last,
                "full_name": f"{first} {last}",
                "email": email,
                "password": password
            })

        return users

    def generate_quiz_questions(self, num_questions: int, points_per_question: int = 50) -> List[Dict]:
        """Generate quiz questions"""
        question_templates = [
            {
                "text": "What is the primary function of {topic}?",
                "answers": [
                    "To manage {function1}",
                    "To create {function2}",
                    "To compile {function3}",
                    "To browse {function4}"
                ]
            },
            {
                "text": "Which {concept} follows the {principle} principle?",
                "answers": [
                    "{option1}",
                    "{option2}",
                    "{option3}",
                    "{option4}"
                ]
            }
        ]

        questions = []
        for i in range(num_questions):
            template = random.choice(question_templates)
            questions.append({
                "question_text": f"Question {i+1}: Sample question text",
                "question_type": "multiple_choice_question",
                "points_possible": points_per_question,
                "answers": [
                    {"answer_text": f"Correct answer", "answer_weight": 100},
                    {"answer_text": f"Wrong answer 1", "answer_weight": 0},
                    {"answer_text": f"Wrong answer 2", "answer_weight": 0},
                    {"answer_text": f"Wrong answer 3", "answer_weight": 0}
                ]
            })

        return questions

    def generate_quiz(self, difficulty: str = "medium") -> Dict:
        """Generate quiz configuration"""
        difficulty_settings = {
            "easy": {"num_questions": 2, "time_limit": 45, "points": 80, "attempts": 3},
            "medium": {"num_questions": 2, "time_limit": 60, "points": 100, "attempts": 2},
            "hard": {"num_questions": 3, "time_limit": 90, "points": 150, "attempts": 1},
        }

        settings = difficulty_settings.get(difficulty, difficulty_settings["medium"])
        points_per_question = settings["points"] // settings["num_questions"]

        # Randomly decide future due date (1-14 days)
        due_days = random.randint(1, 14)
        due_date = self.current_date + timedelta(days=due_days)

        return {
            "title": f"Quiz - Sample Title",
            "description": "Sample quiz description covering key concepts.",
            "quiz_type": random.choice(["Graded Quiz", "assignment"]),
            "time_limit": settings["time_limit"],
            "shuffle_answers": True,
            "show_correct_answers": random.choice([True, False]),
            "allowed_attempts": settings["attempts"],
            "scoring_policy": "keep_highest",
            "points_possible": settings["points"],
            "due_at": due_date.strftime("%Y-%m-%dT23:59:00Z"),
            "questions": self.generate_quiz_questions(settings["num_questions"], points_per_question)
        }

    def generate_assignment(self, difficulty: str = "medium") -> Dict:
        """Generate assignment configuration"""
        difficulty_settings = {
            "easy": {"points": 50, "types": "online_text_entry"},
            "medium": {"points": 100, "types": ["online_upload", "online_text_entry"]},
            "hard": {"points": 150, "types": ["online_upload", "online_text_entry"]},
        }

        settings = difficulty_settings.get(difficulty, difficulty_settings["medium"])

        # Randomly decide future due date (1-14 days)
        due_days = random.randint(1, 14)
        due_date = self.current_date + timedelta(days=due_days)

        assignment = {
            "name": "Sample Assignment",
            "description": "Sample assignment description with requirements.",
            "points_possible": settings["points"],
            "due_at": due_date.strftime("%Y-%m-%dT23:59:00Z"),
            "submission_types": settings["types"],
            "published": True
        }

        # If complex assignment, add allowed file extensions
        if isinstance(settings["types"], list) and "online_upload" in settings["types"]:
            assignment["allowed_extensions"] = ["pdf", "zip", "docx"]

        return assignment

    def generate_announcement(self, course: Dict, has_exam: bool = True) -> Dict:
        """Generate course announcement"""
        if not has_exam or course.get("exam_type") == "no_exam":
            return {
                "title": f"Course Information - {course['course_code']}",
                "content": f"Welcome to {course['name']}! This course does not have a traditional final exam."
            }

        exam_time = course.get("exam_time", "TBD")
        if exam_time == "TBD":
            return {
                "title": f"Final Exam Announcement - {course['course_code']}",
                "content": "Exam information is to be confirmed and will be officially communicated via email."
            }

        exam_date = datetime.strptime(exam_time, "%Y-%m-%d %H:%M")
        duration = course.get("duration", "120")
        location = course.get("location", "TBD")

        content = f"""Dear {course['course_code']} students,

This is to announce that the final exam for {course['name']} will be held on:

Date: {exam_date.strftime('%B %d, %Y')}
Time: {exam_date.strftime('%I:%M %p')}
Duration: {duration} minutes
Location: {location}

"""

        if course.get("exam_type") == "open_book":
            content += "Note: This is an OPEN BOOK exam. You may bring your textbooks and notes.\n\n"

        content += """Please arrive 15 minutes before the exam time. Bring your student ID and necessary writing materials.

Good luck!

Best regards,
Course Instructor"""

        return {
            "title": f"Final Exam Announcement - {course['course_code']}",
            "content": content
        }

    def generate_courses(self,
                        num_courses: int = 10,
                        quiz_probability: float = 0.8,
                        assignment_probability: float = 0.7,
                        quiz_difficulty: str = "medium",
                        assignment_difficulty: str = "medium",
                        exemption_probability: float = 0.1,
                        no_exam_probability: float = 0.15,
                        student_emails: List[str] = None) -> List[Dict]:
        """Generate list of course configurations"""

        courses = []
        used_codes = set()

        # Collect all course templates
        all_templates = []
        for category, templates in self.COURSE_TEMPLATES.items():
            all_templates.extend(templates)

        # Randomly select courses (allow template reuse to support more courses, upper limit 800)
        num_courses = min(num_courses, 800)
        if num_courses <= len(all_templates):
            selected_templates = random.sample(all_templates, num_courses)
        else:
            # First use all templates, then randomly repeat to fill remaining quantity
            selected_templates = all_templates.copy()
            remaining = num_courses - len(all_templates)
            selected_templates.extend(random.choices(all_templates, k=remaining))

        for idx, template in enumerate(selected_templates):
            # Ensure unique course code
            course_code = f"{template['code']}-{idx+1}"
            while course_code in used_codes:
                course_code = f"{template['code']}-{random.randint(1, 99)}"
            used_codes.add(course_code)

            # Basic course information
            course = {
                "name": f"{template['name']}-{idx+1}",
                "course_code": course_code,
                "teacher": random.choice(self.TEACHER_EMAILS),
                "credits": template["credits"],
            }

            # Exam type and time
            exam_type = random.choice(self.EXAM_TYPES) if random.random() < no_exam_probability else random.choice(["closed_book", "open_book"])
            course["exam_type"] = exam_type

            if exam_type != "no_exam":
                # Generate exam time (2-4 weeks in the future)
                exam_date = self.current_date + timedelta(days=random.randint(14, 28))
                course["exam_time"] = exam_date.strftime("%Y-%m-%d %H:%M")
                course["duration"] = str(random.choice([90, 120, 150, 180]))
                course["duration_unit"] = "minutes"

                # Generate exam location
                building = random.choice(self.BUILDINGS)
                room = random.randint(101, 505)
                course["location"] = f"Building {building} Room {room}"
            else:
                course["duration"] = "20"
                course["duration_unit"] = "minutes"
                course["location"] = f"Building {random.choice(self.BUILDINGS)} Room {random.randint(101, 505)}"
                course["assessment"] = random.choice([
                    "Assignments + Group Presentation",
                    "Project + Report",
                    "Portfolio Assessment"
                ])

            # Exemption score (low probability)
            if random.random() < exemption_probability:
                course["exemption_score"] = random.choice([85, 90, 95])

            # Generate quiz (based on probability)
            if random.random() < quiz_probability:
                course["quiz"] = self.generate_quiz(quiz_difficulty)
                course["quiz"]["title"] = f"{course_code} {random.choice(['Midterm', 'Chapter', 'Unit'])} Quiz"

            # Generate assignment (based on probability)
            if random.random() < assignment_probability:
                course["assignment"] = self.generate_assignment(assignment_difficulty)
                course["assignment"]["name"] = f"{course_code} {random.choice(['Homework', 'Project', 'Assignment'])}"

            # Generate announcement
            course["announcement"] = self.generate_announcement(course, exam_type != "no_exam")

            # Add students
            if student_emails:
                course["students"] = student_emails

            courses.append(course)

        return courses

    def generate_submission_config(self,
                                   courses: List[Dict],
                                   submission_probability: float = 0.3) -> Dict:
        """Generate assignment submission configuration (noise)"""
        submissions = {}

        for course in courses:
            course_code = course["course_code"]

            # Decide whether to add submitted status for this course's assignment
            if "assignment" in course and random.random() < submission_probability:
                submissions[course_code] = {
                    "assignment_submitted": True,
                    "submission_time": (self.current_date - timedelta(days=random.randint(1, 7))).isoformat()
                }

        return submissions

    def generate_memory_json(self, courses: List[Dict], exemption_meet_probability: float = 0.6) -> Dict:
        """Generate Ryan Brown's memory.json, including exemption course information

        Args:
            courses: Course list
            exemption_meet_probability: Probability that Ryan meets exemption requirements (0-1)
        """

        # Basic personal information
        observations = [
            "Student ID: 2201210606",
            "Email: ryan.brown93@mcp.com",
            "Address: Building 1, Unit 1, Haidian Road Community",
            "Phone: 13812345678",
            "Major: Computer Science and Technology",
            "Hobbies: Programming, Reading, Basketball",
            "Graduation year: 2024",
            "GPA: 3.8",
            "University: Peking University",
            "Degree: Bachelor's",
            "Education period: 2020-09 to 2024-06",
            "Currently pursuing: Master's degree",
            "Health condition: Gout, cannot eat seafood",
            "Daily routine: Regular schedule",
            "Mental health: Healthy",
            "Personality: Lively",
            "Swimming ability: Cannot swim",
            "Birthday: 2000-01-01"
        ]

        # Add exemption course information
        exemption_courses = []
        non_exemption_courses = []

        for course in courses:
            if "exemption_score" in course:
                exemption_score = course["exemption_score"]
                course_name = course["name"]
                course_code = course["course_code"]

                # Generate different exemption exam types based on course type
                if "English" in course_name or "ENG" in course_code:
                    exam_type = "entrance English exam"
                elif "Math" in course_name or "MATH" in course_code:
                    exam_type = "mathematics placement test"
                elif "Physics" in course_name or "PHYS" in course_code:
                    exam_type = "physics proficiency exam"
                else:
                    exam_type = f"{course_name} qualification exam"

                # Randomly decide if Ryan meets exemption requirements
                meets_requirement = random.random() < exemption_meet_probability

                if meets_requirement:
                    # Meets exemption requirement: score slightly above or equal to exemption score
                    actual_score = exemption_score + random.randint(0, 5)
                    observation = f"Score for the {exam_type}: {actual_score}. The exemption requirement is {exemption_score}, which has been met. This may qualify for course exemption for {course_code}."

                    exemption_courses.append({
                        "course_code": course_code,
                        "course_name": course_name,
                        "exemption_score": exemption_score,
                        "actual_score": actual_score,
                        "exam_type": exam_type,
                        "qualified": True
                    })
                else:
                    # Does not meet exemption requirement: score below exemption score
                    actual_score = exemption_score - random.randint(1, 10)
                    observation = f"Score for the {exam_type}: {actual_score}. The exemption requirement is {exemption_score}, which has not been met. Need to take {course_code}."

                    non_exemption_courses.append({
                        "course_code": course_code,
                        "course_name": course_name,
                        "exemption_score": exemption_score,
                        "actual_score": actual_score,
                        "exam_type": exam_type,
                        "qualified": False
                    })

                observations.append(observation)

        memory = {
            "type": "entity",
            "entityType": "Person",
            "name": "Ryan Brown",
            "observations": observations
        }

        return memory, exemption_courses, non_exemption_courses

    def generate_groundtruth_csv(self,
                                 courses: List[Dict],
                                 exemption_courses: List[Dict],
                                 submissions: Dict) -> Tuple[List[Dict], List[Dict]]:
        """Generate groundtruth CSV data (tasks Ryan Brown needs to complete)"""

        # Get course_code set for exempted courses
        exempted_course_codes = {ec['course_code'] for ec in exemption_courses}

        # Get course_code set for submitted assignments
        submitted_course_codes = set(submissions.keys())

        print(f"\n[INFO] Groundtruth filtering information:")
        print(f"   Exempt courses: {len(exempted_course_codes)} - {list(exempted_course_codes) if exempted_course_codes else 'None'}")
        print(f"   Submitted assignments: {len(submitted_course_codes)} - {list(submitted_course_codes) if submitted_course_codes else 'None'}")

        quiz_data = []
        assignment_data = []
        filtered_assignments = []

        for course in courses:
            course_code = course['course_code']
            course_name = course['name']
            credits = course.get('credits', 3)

            # If course is exempt, skip all tasks
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

            # Process Assignment (exclude already submitted)
            if 'assignment' in course:
                if course_code not in submitted_course_codes:
                    assignment = course['assignment']
                    assignment_data.append({
                        'course_code': course_code,
                        'assignment_title': assignment.get('name', 'Assignment'),
                        'description': assignment.get('description', ''),
                        'deadline': assignment.get('due_at', ''),
                        'course_name': course_name,
                        'points_possible': assignment.get('points_possible', 100)
                    })
                else:
                    # Record filtered assignments
                    filtered_assignments.append(course_code)

        # Sort by deadline and course_code
        # Sorting rules:
        # 1. First by deadline chronological order
        # 2. Tasks with same deadline by course_code dictionary order
        from datetime import datetime

        def sort_key(item):
            try:
                deadline = datetime.fromisoformat(item['deadline'].replace('Z', '+00:00'))
            except:
                deadline = datetime.max
            return (deadline, item['course_code'])

        quiz_data.sort(key=sort_key)
        assignment_data.sort(key=sort_key)

        # Print filtering results
        if filtered_assignments:
            print(f"   Filtered submitted assignments: {filtered_assignments}")

        return quiz_data, assignment_data

    def save_groundtruth_csv(self,
                            quiz_data: List[Dict],
                            assignment_data: List[Dict],
                            output_dir: Path):
        """Save groundtruth CSV files"""
        import csv

        groundtruth_dir = output_dir / "groundtruth_workspace"
        groundtruth_dir.mkdir(parents=True, exist_ok=True)

        # Save quiz_info.csv (save column names even if data is empty)
        quiz_csv_path = groundtruth_dir / "quiz_info.csv"
        fieldnames_quiz = ['course_code', 'course_name', 'credits', 'quiz_title',
                          'number_of_questions', 'time_limit', 'allowed_attempts',
                          'scoring_policy', 'points_possible', 'deadline']
        with open(quiz_csv_path, 'w', encoding='utf-8', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames_quiz)
            writer.writeheader()
            if quiz_data:
                writer.writerows(quiz_data)
            f.write('\n')  # Add empty line at end of file
        print(f"[SAVED] {quiz_csv_path} ({len(quiz_data)} quizzes)")

        # Save assignment_info.csv (save column names even if data is empty)
        assignment_csv_path = groundtruth_dir / "assignment_info.csv"
        fieldnames_assignment = ['course_code', 'assignment_title', 'description',
                                'deadline', 'course_name', 'points_possible']
        with open(assignment_csv_path, 'w', encoding='utf-8', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames_assignment)
            writer.writeheader()
            if assignment_data:
                writer.writerows(assignment_data)
            f.write('\n')  # Add empty line at end of file
        print(f"[SAVED] {assignment_csv_path} ({len(assignment_data)} assignments)")

        return quiz_csv_path, assignment_csv_path

    def save_config(self,
                   output_dir: Path,
                   num_courses: int = 10,
                   num_students: int = 3,
                   quiz_probability: float = 0.8,
                   assignment_probability: float = 0.7,
                   submission_probability: float = 0.3,
                   quiz_difficulty: str = "medium",
                   assignment_difficulty: str = "medium",
                   exemption_probability: float = 0.1,
                   no_exam_probability: float = 0.15,
                   exemption_meet_probability: float = 0.6):
        """Save complete task configuration"""

        print(f"[GENERATE] Generating task configuration...")
        print(f"   Number of courses: {num_courses}")
        print(f"   Number of students: {num_students}")
        print(f"   Quiz probability: {quiz_probability:.0%}")
        print(f"   Assignment probability: {assignment_probability:.0%}")
        print(f"   Submitted probability: {submission_probability:.0%}")
        print(f"   Exemption probability: {exemption_probability:.0%}")
        print(f"   No exam probability: {no_exam_probability:.0%}")

        # Generate student users
        students = self.generate_student_users(num_students)
        student_emails = [s["email"] for s in students]

        # Generate courses
        courses = self.generate_courses(
            num_courses=num_courses,
            quiz_probability=quiz_probability,
            assignment_probability=assignment_probability,
            quiz_difficulty=quiz_difficulty,
            assignment_difficulty=assignment_difficulty,
            exemption_probability=exemption_probability,
            no_exam_probability=no_exam_probability,
            student_emails=student_emails
        )

        # Generate submission configuration
        submissions = self.generate_submission_config(courses, submission_probability)

        # Generate Ryan Brown's memory.json
        memory, exemption_courses, non_exemption_courses = self.generate_memory_json(
            courses,
            exemption_meet_probability
        )

        # Save files
        files_dir = output_dir / "files"
        files_dir.mkdir(parents=True, exist_ok=True)

        # Save course_config.json
        course_config_path = files_dir / "course_config.json"
        with open(course_config_path, 'w', encoding='utf-8') as f:
            json.dump({"courses": courses}, f, indent=2, ensure_ascii=False)
        print(f"[SAVED] {course_config_path}")

        # Save canvas_users.json
        users_path = files_dir / "canvas_users.json"
        with open(users_path, 'w', encoding='utf-8') as f:
            json.dump(students, f, indent=2, ensure_ascii=False)
        print(f"[SAVED] {users_path}")

        # Save submission_config.json (for preprocess)
        submission_path = files_dir / "submission_config.json"
        with open(submission_path, 'w', encoding='utf-8') as f:
            json.dump(submissions, f, indent=2, ensure_ascii=False)
        print(f"[SAVED] {submission_path}")

        # Save memory.json to initial_workspace/memory/
        memory_dir = output_dir / "initial_workspace" / "memory"
        memory_dir.mkdir(parents=True, exist_ok=True)
        memory_path = memory_dir / "memory.json"
        with open(memory_path, 'w', encoding='utf-8') as f:
            json.dump(memory, f, ensure_ascii=False)
        print(f"[SAVED] {memory_path}")

        # Generate and save groundtruth CSV files
        quiz_data, assignment_data = self.generate_groundtruth_csv(
            courses,
            exemption_courses,
            submissions
        )
        self.save_groundtruth_csv(quiz_data, assignment_data, output_dir)

        # Statistics
        total_quizzes = sum(1 for c in courses if "quiz" in c)
        total_assignments = sum(1 for c in courses if "assignment" in c)
        total_tasks = total_quizzes + total_assignments
        submitted_count = len(submissions)
        qualified_exemption_count = len(exemption_courses)
        total_exemption_courses = qualified_exemption_count + len(non_exemption_courses)

        print(f"\n[STATS] Statistics:")
        print(f"   Total courses: {len(courses)}")
        print(f"   Courses with exemption mechanism: {total_exemption_courses}")
        print(f"   Ryan meets exemption requirement: {qualified_exemption_count}")
        print(f"   Ryan does not meet exemption requirement: {len(non_exemption_courses)}")
        print(f"   Total quizzes: {total_quizzes}")
        print(f"   Total assignments: {total_assignments}")
        print(f"   Total tasks: {total_tasks}")
        print(f"   Submitted count: {submitted_count}")
        print(f"   Remaining to complete: {total_tasks - submitted_count}")
        print(f"\n[GROUNDTRUTH] Tasks Ryan needs to complete:")
        print(f"   Quiz count: {len(quiz_data)}")
        print(f"   Assignment count: {len(assignment_data)}")
        print(f"   Total: {len(quiz_data) + len(assignment_data)}")

        if qualified_exemption_count > 0:
            print(f"\n[EXEMPT] Courses Ryan meets exemption requirement for (added to memory):")
            for exemption in exemption_courses:
                print(f"   - {exemption['course_code']}: {exemption['course_name']}")
                print(f"     Exemption requirement: {exemption['exemption_score']}, Ryan's score: {exemption['actual_score']} [PASS]")

        if len(non_exemption_courses) > 0:
            print(f"\n[NOT EXEMPT] Courses Ryan does not meet exemption requirement for (must take):")
            for course_info in non_exemption_courses:
                print(f"   - {course_info['course_code']}: {course_info['course_name']}")
                print(f"     Exemption requirement: {course_info['exemption_score']}, Ryan's score: {course_info['actual_score']} [FAIL]")

        return {
            "courses": len(courses),
            "total_exemption_courses": total_exemption_courses,
            "qualified_exemptions": qualified_exemption_count,
            "unqualified_exemptions": len(non_exemption_courses),
            "quizzes": total_quizzes,
            "assignments": total_assignments,
            "total_tasks": total_tasks,
            "submitted": submitted_count,
            "remaining": total_tasks - submitted_count,
            "groundtruth_quizzes": len(quiz_data),
            "groundtruth_assignments": len(assignment_data),
            "groundtruth_total": len(quiz_data) + len(assignment_data)
        }


def main():
    parser = argparse.ArgumentParser(description="Canvas List Test Task Configuration Generator")

    # Basic parameters
    parser.add_argument("--num-courses", type=int, default=10,
                       help="Number of courses (default: 10)")
    parser.add_argument("--num-students", type=int, default=3,
                       help="Number of students (default: 3)")

    # Probability parameters
    parser.add_argument("--quiz-prob", type=float, default=0.8,
                       help="Probability each course has a quiz (0-1, default: 0.8)")
    parser.add_argument("--assignment-prob", type=float, default=0.7,
                       help="Probability each course has an assignment (0-1, default: 0.7)")
    parser.add_argument("--submission-prob", type=float, default=0.3,
                       help="Probability assignment is already submitted (noise, 0-1, default: 0.3)")
    parser.add_argument("--exemption-prob", type=float, default=0.1,
                       help="Probability course can be exempted (0-1, default: 0.1)")
    parser.add_argument("--exemption-meet-prob", type=float, default=0.6,
                       help="Probability Ryan meets exemption requirement (0-1, default: 0.6)")
    parser.add_argument("--no-exam-prob", type=float, default=0.15,
                       help="Probability course has no exam (0-1, default: 0.15)")

    # Difficulty parameters
    parser.add_argument("--quiz-difficulty", choices=["easy", "medium", "hard"], default="medium",
                       help="Quiz difficulty (default: medium)")
    parser.add_argument("--assignment-difficulty", choices=["easy", "medium", "hard"], default="medium",
                       help="Assignment difficulty (default: medium)")

    # Other parameters
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed (default: 42)")
    parser.add_argument("--output-dir", type=str, default=".",
                       help="Output directory (default: current directory)")

    args = parser.parse_args()

    # Generate configuration
    generator = TaskConfigGenerator(seed=args.seed)
    output_dir = Path(args.output_dir)

    stats = generator.save_config(
        output_dir=output_dir,
        num_courses=args.num_courses,
        num_students=args.num_students,
        quiz_probability=args.quiz_prob,
        assignment_probability=args.assignment_prob,
        submission_probability=args.submission_prob,
        quiz_difficulty=args.quiz_difficulty,
        assignment_difficulty=args.assignment_difficulty,
        exemption_probability=args.exemption_prob,
        exemption_meet_probability=args.exemption_meet_prob,
        no_exam_probability=args.no_exam_prob
    )

    print(f"\n[COMPLETE] Configuration generation complete!")
    print(f"\n[USAGE] Example usage:")
    print(f"   python preprocess/main.py --agent_workspace /path/to/workspace")


if __name__ == "__main__":
    main()
