#!/usr/bin/env python3
"""
Canvas Exam Arrangement Task - Dynamic Data Generator

Generates:
- course_config.json: Canvas courses with exam announcements
- email_config.json: Email-based exam notifications
- canvas_users.json: Student and teacher user data
- groundtruth exam_schedule.xlsx
"""

import random
import json
from pathlib import Path
from argparse import ArgumentParser
from datetime import datetime, timedelta
from typing import List, Dict, Tuple, Optional
import sys

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
except ImportError:
    print("Error: openpyxl is required. Install it with: pip install openpyxl")
    sys.exit(1)


class ExamDataGenerator:
    """Generate exam arrangement task data with configurable difficulty"""
    
    def __init__(self,
                 seed: int = 42,
                 num_courses: int = 10,
                 canvas_exam_rate: float = 0.7,
                 email_exam_rate: float = 0.2,
                 no_exam_rate: float = 0.1,
                 tbd_rate: float = 0.2,
                 exemption_rate: float = 0.1,
                 past_exam_rate: float = 0.15,
                 distraction_emails: int = 3,
                 distraction_announcements: int = 2,
                 difficulty: str = "medium"):
        """
        Initialize generator
        
        Args:
            seed: Random seed
            num_courses: Number of courses to generate
            canvas_exam_rate: Probability of exam info via Canvas announcement
            email_exam_rate: Probability of exam info via Email
            no_exam_rate: Probability of no final exam
            tbd_rate: Probability of TBD exam info
            exemption_rate: Probability of exemption
            past_exam_rate: Probability of past exams (before Jan 15, 2025)
            distraction_emails: Number of distraction emails
            distraction_announcements: Number of distraction announcements per course
            difficulty: Difficulty level
        """
        random.seed(seed)
        self.seed = seed
        self.num_courses = num_courses
        self.canvas_exam_rate = canvas_exam_rate
        self.email_exam_rate = email_exam_rate
        self.no_exam_rate = no_exam_rate
        self.tbd_rate = tbd_rate
        self.exemption_rate = exemption_rate
        self.past_exam_rate = past_exam_rate
        self.distraction_emails = distraction_emails
        self.distraction_announcements = distraction_announcements
        self.difficulty = difficulty
        
        # Course templates (expanded to 500 courses)
        self.course_templates = self._generate_course_templates()
        
        # Teacher names
        self.teachers = [
            ("Debra Flores", "debra_flores76@mcp.com"),
            ("Steven Hernandez", "steven.hernandez@mcp.com"),
            ("Christopher Miller", "christopher.miller@mcp.com"),
            ("Smith Johnson", "smith.johnson@mcp.com"),
            ("Emily Davis", "emily.davis@mcp.com"),
        ]
        
        # Exam locations (expanded to support 500 courses)
        self.locations = self._generate_exam_locations()
        
        # Exam reference date: January 15, 2025
        self.reference_date = datetime(2025, 1, 15)
        
        # Track used exam time slots to avoid conflicts
        self.used_time_slots = set()  # Store (date, time) tuples

    def _generate_course_templates(self) -> List[Tuple[str, str, int]]:
        """Generate 500 course templates programmatically.

        Returns:
            List of (course_name, course_code, credits) tuples
        """
        templates = []

        # Define course categories with prefixes and course name patterns
        course_categories = {
            # Computer Science (CS) - 60 courses
            "CS": [
                "Introduction to Computer Science", "Data Structures and Algorithms",
                "Database Systems", "Software Engineering Practice", "Computer Networks",
                "Operating Systems", "Software Engineering", "Artificial Intelligence",
                "Machine Learning", "Computer Graphics", "Compiler Design",
                "Parallel Computing", "Computer Architecture", "Algorithm Analysis",
                "Theory of Computation", "Programming Languages", "Computer Security",
                "Distributed Computing", "Real-time Systems", "Quantum Computing",
                "Bioinformatics", "Computational Geometry", "Graph Theory",
                "Automata Theory", "Formal Methods", "Logic Programming",
                "Functional Programming", "Object-Oriented Design", "Systems Programming",
                "Network Programming", "Concurrent Programming", "GPU Programming",
                "High Performance Computing", "Scientific Computing", "Numerical Methods",
                "Symbolic Computation", "Computer Algebra", "Computational Complexity",
                "Randomized Algorithms", "Approximation Algorithms", "Online Algorithms",
                "Streaming Algorithms", "Sublinear Algorithms", "Parameterized Algorithms",
                "Fixed-Parameter Tractability", "Algorithmic Game Theory", "Mechanism Design",
                "Social Network Analysis", "Web Science", "Information Retrieval",
                "Text Mining", "Sentiment Analysis", "Opinion Mining",
                "Recommendation Systems", "Collaborative Filtering", "Knowledge Graphs",
                "Semantic Web", "Ontology Engineering", "Description Logics",
            ],
            # Mathematics (MATH) - 50 courses
            "MATH": [
                "Linear Algebra", "Advanced Mathematics", "Probability and Statistics",
                "Discrete Mathematics", "Calculus I", "Calculus II", "Calculus III",
                "Numerical Analysis", "Mathematical Modeling", "Abstract Algebra",
                "Real Analysis", "Complex Analysis", "Differential Equations",
                "Partial Differential Equations", "Number Theory", "Combinatorics",
                "Graph Theory", "Topology", "Geometry", "Algebraic Geometry",
                "Differential Geometry", "Functional Analysis", "Measure Theory",
                "Stochastic Processes", "Mathematical Logic", "Set Theory",
                "Category Theory", "Homological Algebra", "Representation Theory",
                "Lie Algebras", "Algebraic Topology", "Algebraic Number Theory",
                "Analytic Number Theory", "Cryptographic Mathematics", "Coding Theory",
                "Information Theory", "Optimization Theory", "Convex Optimization",
                "Nonlinear Optimization", "Integer Programming", "Dynamic Programming",
                "Control Theory", "Game Theory", "Decision Theory",
                "Probability Theory", "Statistical Inference", "Bayesian Statistics",
                "Multivariate Statistics", "Time Series Analysis", "Survival Analysis",
            ],
            # Physics (PHYS) - 40 courses
            "PHYS": [
                "General Physics I", "General Physics II", "Classical Mechanics",
                "Electromagnetism", "Thermodynamics", "Statistical Mechanics",
                "Quantum Mechanics", "Quantum Field Theory", "Particle Physics",
                "Nuclear Physics", "Atomic Physics", "Molecular Physics",
                "Solid State Physics", "Condensed Matter Physics", "Optics",
                "Acoustics", "Astrophysics", "Cosmology", "Relativity",
                "Plasma Physics", "Fluid Dynamics", "Computational Physics",
                "Mathematical Physics", "Theoretical Physics", "Experimental Physics",
                "Quantum Computing Physics", "Quantum Information", "Quantum Optics",
                "Laser Physics", "Photonics", "Nanophysics", "Biophysics",
                "Medical Physics", "Geophysics", "Atmospheric Physics",
                "Space Physics", "Semiconductor Physics", "Superconductivity",
                "Magnetism", "Surface Physics",
            ],
            # Chemistry (CHEM) - 30 courses
            "CHEM": [
                "General Chemistry", "Organic Chemistry", "Inorganic Chemistry",
                "Physical Chemistry", "Analytical Chemistry", "Biochemistry",
                "Polymer Chemistry", "Materials Chemistry", "Environmental Chemistry",
                "Medicinal Chemistry", "Pharmaceutical Chemistry", "Computational Chemistry",
                "Quantum Chemistry", "Spectroscopy", "Chromatography",
                "Electrochemistry", "Photochemistry", "Surface Chemistry",
                "Colloid Chemistry", "Food Chemistry", "Agricultural Chemistry",
                "Industrial Chemistry", "Green Chemistry", "Nanochemistry",
                "Supramolecular Chemistry", "Organometallic Chemistry", "Coordination Chemistry",
                "Solid State Chemistry", "Nuclear Chemistry", "Radiochemistry",
            ],
            # Biology (BIO) - 30 courses
            "BIO": [
                "General Biology", "Cell Biology", "Molecular Biology",
                "Genetics", "Genomics", "Proteomics", "Bioinformatics",
                "Evolutionary Biology", "Ecology", "Microbiology",
                "Immunology", "Virology", "Parasitology", "Neurobiology",
                "Developmental Biology", "Plant Biology", "Animal Biology",
                "Marine Biology", "Conservation Biology", "Systems Biology",
                "Synthetic Biology", "Structural Biology", "Biochemistry",
                "Biotechnology", "Bioengineering", "Biomedicine",
                "Pharmacology", "Toxicology", "Epidemiology", "Biostatistics",
            ],
            # Electrical Engineering (EE) - 40 courses
            "EE": [
                "Circuit Analysis", "Electronics", "Digital Electronics",
                "Analog Electronics", "Power Electronics", "Microelectronics",
                "VLSI Design", "Embedded Systems", "Microprocessors",
                "Digital Signal Processing", "Image Processing", "Speech Processing",
                "Communication Systems", "Wireless Communications", "Antenna Design",
                "Electromagnetic Fields", "Control Systems", "Power Systems",
                "Electric Machines", "Renewable Energy Systems", "Smart Grid",
                "Robotics", "Mechatronics", "Instrumentation",
                "Sensors and Actuators", "Biomedical Electronics", "Medical Imaging",
                "Radar Systems", "Satellite Communications", "Optical Communications",
                "RF Engineering", "Microwave Engineering", "Photovoltaics",
                "Battery Technology", "Electric Vehicles", "Industrial Automation",
                "PLC Programming", "SCADA Systems", "IoT Systems", "Wearable Electronics",
            ],
            # Mechanical Engineering (ME) - 30 courses
            "ME": [
                "Engineering Mechanics", "Strength of Materials", "Fluid Mechanics",
                "Thermodynamics", "Heat Transfer", "Machine Design",
                "Manufacturing Processes", "CAD CAM", "Finite Element Analysis",
                "Vibrations", "Acoustics Engineering", "Automotive Engineering",
                "Aerospace Engineering", "Marine Engineering", "HVAC Systems",
                "Refrigeration", "Turbomachinery", "Combustion Engineering",
                "Materials Science", "Composite Materials", "Metallurgy",
                "Tribology", "Biomechanics", "Robotics and Automation",
                "Mechatronics", "Product Design", "Rapid Prototyping",
                "Quality Engineering", "Reliability Engineering", "Maintenance Engineering",
            ],
            # Civil Engineering (CE) - 25 courses
            "CE": [
                "Structural Analysis", "Structural Design", "Reinforced Concrete",
                "Steel Structures", "Foundation Engineering", "Geotechnical Engineering",
                "Soil Mechanics", "Rock Mechanics", "Hydraulics",
                "Hydrology", "Water Resources", "Environmental Engineering",
                "Transportation Engineering", "Highway Engineering", "Traffic Engineering",
                "Railway Engineering", "Bridge Engineering", "Tunnel Engineering",
                "Construction Management", "Project Management", "Cost Estimation",
                "Surveying", "Remote Sensing", "GIS Applications", "Urban Planning",
            ],
            # Business (BUS) - 35 courses
            "BUS": [
                "Principles of Management", "Organizational Behavior", "Human Resource Management",
                "Strategic Management", "Operations Management", "Supply Chain Management",
                "Marketing Management", "Consumer Behavior", "Digital Marketing",
                "Brand Management", "Sales Management", "Retail Management",
                "Financial Management", "Corporate Finance", "Investment Analysis",
                "Portfolio Management", "Risk Management", "Insurance",
                "Accounting Principles", "Cost Accounting", "Management Accounting",
                "Auditing", "Taxation", "Business Law",
                "International Business", "Global Trade", "Entrepreneurship",
                "Innovation Management", "Business Analytics", "Business Intelligence",
                "E-Commerce", "Business Ethics", "Corporate Governance",
                "Leadership", "Negotiation Skills",
            ],
            # Economics (ECON) - 25 courses
            "ECON": [
                "Microeconomics", "Macroeconomics", "Econometrics",
                "International Economics", "Development Economics", "Labor Economics",
                "Public Economics", "Health Economics", "Environmental Economics",
                "Agricultural Economics", "Industrial Economics", "Financial Economics",
                "Monetary Economics", "Banking", "Behavioral Economics",
                "Experimental Economics", "Game Theory", "Mechanism Design",
                "Economic History", "History of Economic Thought", "Mathematical Economics",
                "Computational Economics", "Urban Economics", "Regional Economics",
                "Political Economy",
            ],
            # Psychology (PSY) - 25 courses
            "PSY": [
                "Introduction to Psychology", "Cognitive Psychology", "Developmental Psychology",
                "Social Psychology", "Clinical Psychology", "Abnormal Psychology",
                "Personality Psychology", "Biological Psychology", "Neuropsychology",
                "Health Psychology", "Educational Psychology", "Industrial Psychology",
                "Organizational Psychology", "Consumer Psychology", "Sports Psychology",
                "Forensic Psychology", "Environmental Psychology", "Positive Psychology",
                "Research Methods", "Psychological Testing", "Psychotherapy",
                "Counseling Psychology", "Child Psychology", "Adolescent Psychology",
                "Geriatric Psychology",
            ],
            # Artificial Intelligence (AI) - 30 courses
            "AI": [
                "Deep Learning", "Natural Language Processing", "Computer Vision",
                "Reinforcement Learning", "Neural Networks", "Convolutional Networks",
                "Recurrent Networks", "Transformer Models", "Generative Models",
                "Adversarial Learning", "Transfer Learning", "Meta Learning",
                "Federated Learning", "AutoML", "Neural Architecture Search",
                "Explainable AI", "Ethical AI", "AI Safety",
                "Robotics AI", "Autonomous Vehicles", "Drone Intelligence",
                "Speech Recognition", "Speech Synthesis", "Dialogue Systems",
                "Question Answering", "Machine Translation", "Sentiment Analysis",
                "Knowledge Representation", "Reasoning Systems", "Planning Systems",
            ],
            # Data Science (DS) - 25 courses
            "DS": [
                "Data Mining", "Big Data Analytics", "Statistical Learning",
                "Predictive Analytics", "Prescriptive Analytics", "Data Visualization",
                "Data Wrangling", "Feature Engineering", "Dimensionality Reduction",
                "Clustering Analysis", "Classification Methods", "Regression Analysis",
                "Time Series Forecasting", "Anomaly Detection", "Text Analytics",
                "Social Media Analytics", "Web Analytics", "Customer Analytics",
                "Healthcare Analytics", "Financial Analytics", "Sports Analytics",
                "Marketing Analytics", "HR Analytics", "Supply Chain Analytics",
                "Operations Analytics",
            ],
            # Information Systems (IS) - 20 courses
            "IS": [
                "Management Information Systems", "Database Management", "Data Warehousing",
                "Business Intelligence", "Enterprise Systems", "ERP Systems",
                "CRM Systems", "Knowledge Management", "Information Architecture",
                "Systems Analysis", "Systems Design", "IT Project Management",
                "IT Governance", "IT Security", "IT Audit",
                "Cloud Computing", "Virtualization", "DevOps",
                "Agile Methods", "Software Quality",
            ],
            # Network (NET) - 20 courses
            "NET": [
                "Network Fundamentals", "Network Architecture", "Network Protocols",
                "Network Security", "Wireless Networks", "Mobile Networks",
                "Optical Networks", "Software Defined Networks", "Network Virtualization",
                "Network Management", "Network Performance", "Network Troubleshooting",
                "Internet of Things", "Edge Computing", "Fog Computing",
                "Content Delivery Networks", "Peer-to-Peer Networks", "Ad Hoc Networks",
                "Sensor Networks", "Vehicular Networks",
            ],
            # Security (SEC) - 20 courses
            "SEC": [
                "Information Security", "Cryptography", "Cybersecurity",
                "Network Security", "Application Security", "Cloud Security",
                "Mobile Security", "IoT Security", "Industrial Security",
                "Security Operations", "Incident Response", "Digital Forensics",
                "Malware Analysis", "Penetration Testing", "Vulnerability Assessment",
                "Security Governance", "Security Compliance", "Privacy Engineering",
                "Blockchain Security", "Quantum Cryptography",
            ],
            # Web Development (WEB) - 15 courses
            "WEB": [
                "Web Development", "Frontend Development", "Backend Development",
                "Full Stack Development", "Web Design", "User Interface Design",
                "User Experience Design", "Web Accessibility", "Web Performance",
                "Progressive Web Apps", "Single Page Applications", "Web APIs",
                "Web Security", "Web Testing", "Web Analytics",
            ],
            # Mobile Development (MOB) - 10 courses
            "MOB": [
                "Mobile App Development", "iOS Development", "Android Development",
                "Cross Platform Development", "Mobile UI Design", "Mobile UX Design",
                "Mobile Testing", "Mobile Security", "Mobile Analytics",
                "Mobile Backend Services",
            ],
            # Cloud Computing (CLOUD) - 10 courses
            "CLOUD": [
                "Cloud Fundamentals", "Cloud Architecture", "Cloud Security",
                "Cloud Migration", "Cloud Native Development", "Serverless Computing",
                "Container Orchestration", "Microservices Architecture", "Cloud DevOps",
                "Multi-Cloud Management",
            ],
            # Human Computer Interaction (HCI) - 10 courses
            "HCI": [
                "Human Computer Interaction", "Interaction Design", "Usability Engineering",
                "Accessibility", "Information Visualization", "Virtual Reality",
                "Augmented Reality", "Mixed Reality", "Haptic Interfaces",
                "Brain Computer Interfaces",
            ],
        }

        course_id = 0
        for prefix, course_names in course_categories.items():
            for i, name in enumerate(course_names):
                course_num = 100 + (i % 5) * 100 + (i // 5) + 1  # Generate course numbers like 101, 102, 201, 202, etc.
                code = f"{prefix}{course_num}"
                credits = random.choice([2, 3, 3, 3, 4, 4])  # Weighted towards 3-4 credits
                templates.append((name, code, credits))
                course_id += 1

        # If we need more courses to reach 500, generate additional ones
        additional_prefixes = ["ADV", "SPL", "SEM", "LAB", "PRJ", "RES", "IND", "HON"]
        additional_topics = [
            "Topics in", "Advanced", "Special Topics in", "Seminar in",
            "Laboratory in", "Project in", "Research in", "Independent Study in",
            "Honors", "Capstone", "Workshop in", "Practicum in",
        ]
        base_subjects = [
            "Computing", "Engineering", "Science", "Technology", "Mathematics",
            "Analytics", "Systems", "Design", "Development", "Research",
            "Innovation", "Applications", "Theory", "Practice", "Methods",
        ]

        while len(templates) < 500:
            prefix = random.choice(additional_prefixes)
            topic = random.choice(additional_topics)
            subject = random.choice(base_subjects)
            course_num = 100 + len(templates) % 400 + 1
            code = f"{prefix}{course_num}"
            name = f"{topic} {subject}"
            credits = random.choice([2, 3, 3, 3, 4, 4])
            templates.append((name, code, credits))

        # If we need more courses to reach 800, generate additional ones
        additional_prefixes = ["ADV", "SPL", "SEM", "LAB", "PRJ", "RES", "IND", "HON", "INT", "GRD"]
        additional_topics = [
            "Topics in", "Advanced", "Special Topics in", "Seminar in",
            "Laboratory in", "Project in", "Research in", "Independent Study in",
            "Honors", "Capstone", "Workshop in", "Practicum in",
            "Introduction to", "Fundamentals of", "Principles of", "Applications of",
        ]
        base_subjects = [
            "Computing", "Engineering", "Science", "Technology", "Mathematics",
            "Analytics", "Systems", "Design", "Development", "Research",
            "Innovation", "Applications", "Theory", "Practice", "Methods",
            "Modeling", "Simulation", "Optimization", "Intelligence", "Learning",
        ]

        while len(templates) < 800:
            prefix = random.choice(additional_prefixes)
            topic = random.choice(additional_topics)
            subject = random.choice(base_subjects)
            course_num = 100 + len(templates) % 600 + 1
            code = f"{prefix}{course_num}"
            name = f"{topic} {subject}"
            credits = random.choice([2, 3, 3, 3, 4, 4])
            templates.append((name, code, credits))

        return templates[:800]  # Ensure exactly 800 courses

    def _generate_exam_locations(self) -> List[str]:
        """Generate exam locations to support 500 courses.

        Returns:
            List of exam location strings
        """
        locations = []

        # Main buildings with multiple rooms
        buildings = [
            ("Main Building", 50),
            ("Science Center", 40),
            ("Engineering Hall", 35),
            ("Business School", 30),
            ("Liberal Arts Building", 25),
            ("Computer Science Building", 20),
            ("Mathematics Building", 15),
            ("Physics Building", 15),
            ("Chemistry Building", 10),
            ("Biology Building", 10),
            ("Library", 8),
            ("Student Center", 5),
            ("Lecture Hall Complex", 20),
            ("Exam Center", 30),
            ("Academic Building A", 15),
            ("Academic Building B", 15),
            ("Academic Building C", 15),
        ]

        for building, num_rooms in buildings:
            for room_num in range(101, 101 + num_rooms):
                locations.append(f"{building}, Room {room_num}")

        # Add some special venues
        special_venues = [
            "Grand Auditorium",
            "Conference Center Hall A",
            "Conference Center Hall B",
            "Sports Arena - Section A",
            "Sports Arena - Section B",
            "Outdoor Amphitheater",
            "Virtual Exam Platform",
        ]
        locations.extend(special_venues)

        return locations

    def check_time_conflict(self, exam_date: str, exam_time: str, duration: int) -> bool:
        """Check if exam time conflicts with existing exams
        
        Args:
            exam_date: Date string in format 'YYYY-MM-DD'
            exam_time: Time string in format 'HH:MM'
            duration: Exam duration in minutes
            
        Returns:
            True if there's a conflict, False otherwise
        """
        # Parse exam start time
        exam_datetime = datetime.strptime(f"{exam_date} {exam_time}", "%Y-%m-%d %H:%M")
        exam_end_datetime = exam_datetime + timedelta(minutes=duration)
        
        # Check against all existing exams
        for used_date, used_time, used_duration in self.used_time_slots:
            used_datetime = datetime.strptime(f"{used_date} {used_time}", "%Y-%m-%d %H:%M")
            used_end_datetime = used_datetime + timedelta(minutes=used_duration)
            
            # Check for overlap: exams overlap if one starts before the other ends
            if exam_datetime < used_end_datetime and exam_end_datetime > used_datetime:
                return True
        
        return False
    
    def generate_exam_time(self, duration: int, is_past: bool = False, max_attempts: int = 500) -> Tuple[str, str]:
        """Generate exam date and time, ensuring no conflicts

        Args:
            duration: Exam duration in minutes
            is_past: If True, generate a date before reference date
            max_attempts: Maximum attempts to find a non-conflicting time

        Returns:
            Tuple of (date_string, time_string)
        """
        # Expanded time slots: 12 slots per day (7:00 to 20:00, every hour except 12:00 lunch)
        exam_hours = [7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19]

        for attempt in range(max_attempts):
            if is_past:
                # Generate past date: 1-45 days before reference date
                days_offset = -random.randint(1, 45)
            else:
                # Exam happens 1-90 days after reference date (expanded to support 800 courses)
                days_offset = random.randint(1, 90)

            exam_date = self.reference_date + timedelta(days=days_offset)

            # Expanded exam times: 12 slots per day
            exam_hour = random.choice(exam_hours)
            exam_time = f"{exam_hour:02d}:00"

            date_str = exam_date.strftime("%Y-%m-%d")

            # Check for conflicts
            if not self.check_time_conflict(date_str, exam_time, duration):
                # No conflict, reserve this time slot
                self.used_time_slots.add((date_str, exam_time, duration))
                return date_str, exam_time

        # If we couldn't find a non-conflicting time, return anyway
        # This shouldn't happen with reasonable parameters
        return exam_date.strftime("%Y-%m-%d"), exam_time
    
    def generate_course_data(self) -> List[Dict]:
        """Generate course configurations"""
        courses = []
        selected_templates = random.sample(self.course_templates, 
                                          min(self.num_courses, len(self.course_templates)))
        
        for idx, (name, code, credits) in enumerate(selected_templates):
            # Add suffix to make unique
            course_name = f"{name}-{idx + 1}"
            course_code = f"{code}-{idx + 1}"
            
            # Assign teacher
            teacher_name, teacher_email = random.choice(self.teachers)
            
            # Determine exam info source using cumulative probability
            rand = random.random()
            
            # Use cumulative probability to ensure correct distribution
            if rand < self.exemption_rate:
                # Exempted course
                info_source = "exempted"
            elif rand < self.exemption_rate + self.no_exam_rate:
                # No final exam
                info_source = "no_exam"
            elif rand < self.exemption_rate + self.no_exam_rate + self.canvas_exam_rate:
                info_source = "canvas"
            elif rand < self.exemption_rate + self.no_exam_rate + self.canvas_exam_rate + self.email_exam_rate:
                info_source = "email"
            else:
                # Fallback to no exam if total probability < 1.0
                info_source = "no_exam"
            
            # Determine if this is a past exam (noise)
            is_past = random.random() < self.past_exam_rate and info_source in ["canvas", "email"]
            
            # Generate exam details
            is_tbd = random.random() < self.tbd_rate and info_source in ["canvas", "email"] and not is_past
            
            if is_tbd:
                exam_date = "TBD"
                exam_time = "TBD"
                duration = "TBD"
                location = "TBD"
            else:
                # Generate duration first (needed for conflict checking)
                duration = random.choice([90, 120, 150, 180])
                
                # Generate exam time, ensuring no conflicts
                exam_date, exam_time = self.generate_exam_time(duration, is_past=is_past)
                
                location = random.choice(self.locations)
            
            exam_type = random.choice(["Open-book", "Closed-book"])
            
            course = {
                "name": course_name,
                "course_code": course_code,
                "teacher": teacher_email,
                "teacher_name": teacher_name,
                "credits": credits,
                "exam_type": exam_type,
                "exam_time": f"{exam_date} {exam_time}" if exam_date != "TBD" else "TBD",
                "duration": str(duration),
                "duration_unit": "minutes",
                "location": location,
                "info_source": info_source,
                "is_tbd": is_tbd,
                "is_past": is_past,
                "exam_date": exam_date,
                "exam_time_only": exam_time,
                "students": []  # Will be populated later
            }
            
            courses.append(course)
        
        return courses
    
    def generate_canvas_users(self, courses: List[Dict]) -> Dict:
        """Generate Canvas users (students and teachers)"""
        users = {
            "students": [
                {
                    "id": "rkelly27",
                    "name": "Ronald Kelly",
                    "email": "rkelly27@mcp.com",
                    "password": "ronald_81q2O"
                }
            ],
            "teachers": []
        }
        
        # Collect unique teachers
        teachers_set = set()
        for course in courses:
            teachers_set.add((course['teacher_name'], course['teacher']))
        
        for name, email in teachers_set:
            users["teachers"].append({
                "name": name,
                "email": email,
                "password": "teacher_pass"
            })
        
        return users
    
    def generate_distraction_announcement(self, course: Dict) -> str:
        """Generate a distraction announcement (not about final exam)"""
        topics = [
            f"Reminder: Assignment {random.randint(1, 5)} is due next week",
            f"Class schedule change: Next lecture moved to {(self.reference_date + timedelta(days=random.randint(1, 3))).strftime('%B %d')}",
            f"Guest lecture: Dr. {random.choice(['Smith', 'Johnson', 'Williams'])} will give a talk on {random.choice(['machine learning', 'cloud computing', 'cybersecurity'])}",
            f"Midterm exam grades are now available on Canvas",
            f"Office hours this week: {random.choice(['Tuesday', 'Wednesday', 'Thursday'])} 2-4 PM",
            f"Project presentations will be held during the last week of classes",
            f"Reading materials for next week have been uploaded",
            f"Survey: Please fill out the course evaluation form",
        ]
        
        return random.choice(topics)
    
    def generate_course_config(self, courses: List[Dict]) -> Dict:
        """Generate course_config.json for Canvas"""
        config_courses = []
        
        for course in courses:
            if course['info_source'] == "exempted":
                # Skip exempted courses (not enrolled)
                continue
            
            course_data = {
                "name": course['name'],
                "course_code": course['course_code'],
                "teacher": course['teacher'],
                "credits": course['credits'],
                "exam_type": course['exam_type'],
                "exam_time": course['exam_time'],
                "duration": course['duration'],
                "duration_unit": course['duration_unit'],
                "location": course['location'],
                "students": ["rkelly27@mcp.com"],
                "announcements": []  # Multiple announcements per course
            }
            
            # Add main announcement for Canvas-sourced exams
            if course['info_source'] == "canvas" or course['info_source'] == "no_exam":
                if course['is_tbd']:
                    announcement_content = self.generate_tbd_announcement(course)
                elif course['info_source'] == "no_exam":
                    announcement_content = self.generate_no_exam_announcement(course)
                else:
                    announcement_content = self.generate_exam_announcement(course)
                
                course_data["announcements"].append({
                    "title": f"Final Exam Announcement - {course['course_code'].split('-')[0]}",
                    "content": announcement_content,
                    "priority": "high"
                })
            
            # Add distraction announcements
            for i in range(self.distraction_announcements):
                course_data["announcements"].append({
                    "title": f"Course Update #{i + 1}",
                    "content": self.generate_distraction_announcement(course),
                    "priority": "normal"
                })
            
            # For backward compatibility, keep single "announcement" field
            if course_data["announcements"]:
                course_data["announcement"] = course_data["announcements"][0]
            
            config_courses.append(course_data)
        
        return {"courses": config_courses}
    
    def generate_exam_announcement(self, course: Dict) -> str:
        """Generate exam announcement content"""
        content = f"""Dear {course['course_code'].split('-')[0]} students,

This is to announce that the final exam for {course['name'].split('-')[0]} will be held on:

📅 Date: {datetime.strptime(course['exam_date'], '%Y-%m-%d').strftime('%B %d, %Y')}
⏰ Time: {course['exam_time_only']} - {(datetime.strptime(course['exam_time_only'], '%H:%M') + timedelta(minutes=int(course['duration']))).strftime('%H:%M')}
⏱️ Duration: {course['duration']} minutes
📍 Location: {course['location']}

Please arrive 15 minutes before the exam time. Bring your student ID and necessary writing materials.

Good luck!

Best regards,
Course Instructor"""
        return content
    
    def generate_tbd_announcement(self, course: Dict) -> str:
        """Generate TBD announcement"""
        return f"""Dear {course['course_code'].split('-')[0]} students,

The final exam schedule for {course['name'].split('-')[0]} will be announced soon. Please stay tuned for updates.

Best regards,
Course Instructor"""
    
    def generate_no_exam_announcement(self, course: Dict) -> str:
        """Generate no exam announcement"""
        return f"""Dear {course['course_code'].split('-')[0]} students,

This course does not have a final exam. Your final grade will be based on coursework and projects.

Best regards,
Course Instructor"""
    
    def generate_distraction_email(self, idx: int) -> Dict:
        """Generate a distraction email (non-exam related)"""
        distraction_topics = [
            {
                "subject": "Campus Library Hours Update",
                "content": "Dear Students,\n\nPlease note that the campus library will have extended hours during finals week:\n\nMonday-Friday: 7:00 AM - 11:00 PM\nSaturday-Sunday: 9:00 AM - 9:00 PM\n\nGood luck with your studies!\n\nCampus Services"
            },
            {
                "subject": "Student Activity: Winter Social Event",
                "content": "Hi everyone,\n\nJoin us for the Winter Social Event on January 20th at 6:00 PM in the Student Center!\n\nFood, games, and prizes!\n\nStudent Council"
            },
            {
                "subject": "IT Services: System Maintenance Notice",
                "content": "Dear Users,\n\nThe university IT system will undergo maintenance on January 16th from 2:00 AM to 4:00 AM.\n\nSome services may be temporarily unavailable.\n\nIT Department"
            },
            {
                "subject": "Career Fair Announcement",
                "content": "Dear Students,\n\nThe annual career fair will be held on February 1st.\n\nDon't miss this opportunity to meet potential employers!\n\nCareer Services"
            },
            {
                "subject": "Health Center: Flu Shot Availability",
                "content": "Dear Students,\n\nFree flu shots are available at the health center.\n\nWalk-ins welcome!\n\nHealth Services"
            },
            {
                "subject": "Parking Permit Renewal Reminder",
                "content": "Dear Students,\n\nYour parking permit expires at the end of this semester.\n\nPlease renew online before January 31st.\n\nParking Services"
            },
            {
                "subject": "Survey: Course Evaluation",
                "content": "Dear Students,\n\nPlease take a moment to complete the course evaluation survey.\n\nYour feedback is important!\n\nAcademic Affairs"
            }
        ]
        
        if idx < len(distraction_topics):
            return distraction_topics[idx]
        else:
            return {
                "subject": f"Campus Update #{idx + 1}",
                "content": "Dear Students,\n\nThis is a general campus update.\n\nBest regards,\nCampus Administration"
            }
    
    def generate_email_config(self, courses: List[Dict]) -> Dict:
        """Generate email_config.json for email-sourced exams with distractions
        
        Note: Always generates config even if no email courses exist, 
        to ensure distraction emails can still be injected.
        """
        # Collect all email-sourced courses
        all_email_courses = [c for c in courses if c['info_source'] == "email"]
        
        # Get first email course for main email_content (if exists)
        # Prefer non-TBD courses
        email_course = None
        non_tbd_email_courses = [c for c in all_email_courses if not c['is_tbd']]
        if non_tbd_email_courses:
            email_course = non_tbd_email_courses[0]
        elif all_email_courses:
            email_course = all_email_courses[0]
        
        config = {
            "server_config": {
                "smtp_server": "localhost",
                "smtp_port": 2525,
                "imap_server": "localhost",
                "imap_port": 1143,
                "use_ssl": False,
                "use_starttls": False,
                "timeout": 30
            },
            "sender_account": {
                "email": "steven.hernandez@mcp.com",
                "password": "SH0913#6pK4u",
                "name": "Steven Hernandez"
            },
            "recipient": {
                "email": "rkelly27@mcp.com",
                "name": "Ronald Kelly",
                "password": "ronald_81q2O"
            },
            "exam_notifications": [],  # All email-sourced exam notifications
            "distraction_emails": [],  # Distraction emails
            "logging": {
                "log_file": "email_send.log",
                "log_level": "INFO",
                "console_output": True
            }
        }
        
        # Add email_content only if there's at least one email course
        if email_course:
            config["email_content"] = {
                "subject": "Exam Notification - Important Reminders",
                "template_file": "exam_notification_template.txt",
                "exam_info": {
                    "course_name": email_course['name'].split('-')[0],
                    "exam_date": email_course['exam_date'],
                    "exam_time": email_course['exam_time_only'],
                    "exam_location": email_course['location'],
                    "exam_type": email_course['exam_type'],
                    "duration": f"{email_course['duration']} minutes" if email_course['duration'] != 'TBD' else 'TBD'
                }
            }
        
        # Add ALL email-sourced exam notifications (including TBD ones)
        for course in all_email_courses:
            notification = {
                "subject": f"Final Exam - {course['name'].split('-')[0]}",
                "course_name": course['name'].split('-')[0],
                "course_code": course['course_code'].split('-')[0],
                "exam_date": course['exam_date'],
                "exam_time": course['exam_time_only'],
                "exam_location": course['location'],
                "exam_type": course['exam_type'],
                "duration": f"{course['duration']} minutes" if course['duration'] != 'TBD' else 'TBD',
                "teacher": course['teacher_name'],
                "teacher_email": course['teacher'],  # Add teacher email for sender
                "is_tbd": course['is_tbd']
            }
            config["exam_notifications"].append(notification)
        
        # Add distraction emails (always generate, even if no email courses)
        for i in range(self.distraction_emails):
            distraction = self.generate_distraction_email(i)
            config["distraction_emails"].append(distraction)
        
        return config
    
    def generate_groundtruth(self, courses: List[Dict]) -> List[Dict]:
        """Generate groundtruth exam schedule
        
        Note: Filters out:
        - Exempted courses
        - Courses with no exam
        - Past exams (before reference date: January 15, 2025)
        """
        exam_schedule = []
        
        for course in courses:
            # Skip exempted courses and courses with no exam
            if course['info_source'] in ["exempted", "no_exam"]:
                continue
            
            # Skip past exams (already happened before Jan 15, 2025)
            if course.get('is_past', False):
                continue
            
            # Include courses with exam info (even if TBD)
            if course['info_source'] in ["canvas", "email"]:
                # Remove suffix from course code and name
                course_code = course['course_code'].split('-')[0]
                course_name = course['name'].split('-')[0]
                teacher_name = course['teacher_name'].split()[0]  # First name only
                teacher_email = course['teacher']  # Full email
                
                # Format date as MM/DD/YYYY (full format with slashes and year)
                if course['exam_date'] != 'TBD':
                    # exam_date is in format 'YYYY-MM-DD', convert to 'MM/DD/YYYY'
                    date_parts = course['exam_date'].split('-')
                    formatted_date = f"{date_parts[1]}/{date_parts[2]}/{date_parts[0]}"
                else:
                    formatted_date = 'TBD'
                
                exam_entry = {
                    "Course Code": course_code,
                    "Course Name": course_name,
                    "Proctor Name": teacher_name,
                    "Proctor Email": teacher_email,
                    "Open-book/Closed-book": course['exam_type'],
                    "Final Date (MM/DD/YYYY)": formatted_date,
                    "Start Time (HH:MM)": course['exam_time_only'],
                    "Duration (minutes)": int(course['duration']) if course['duration'] != 'TBD' else 'TBD',
                    "Location": course['location'],
                    "Information Source(Announcement/Email/Message)": "Email" if course['info_source'] == "email" else "Announcement",
                    "Course Credit": course['credits']
                }
                
                exam_schedule.append(exam_entry)
        
        # Sort by exam date and time (from nearest to farthest, TBD at the end)
        def sort_key(x):
            date_str = x["Final Date (MM/DD/YYYY)"]
            time_str = x["Start Time (HH:MM)"]
            
            if date_str == 'TBD' or time_str == 'TBD':
                return ('9999', '99', '99', '99', '99')  # TBD at end
            
            # Parse MM/DD/YYYY to comparable tuple
            parts = date_str.split('/')
            if len(parts) == 3:
                # Parse time HH:MM
                time_parts = time_str.split(':')
                if len(time_parts) == 2:
                    # Return (YYYY, MM, DD, HH, MM) for sorting
                    return (parts[2], parts[0].zfill(2), parts[1].zfill(2), 
                           time_parts[0].zfill(2), time_parts[1].zfill(2))
                return (parts[2], parts[0].zfill(2), parts[1].zfill(2), '00', '00')
            return ('9999', '99', '99', '99', '99')
        
        # Sort in ascending order (nearest first)
        exam_schedule.sort(key=sort_key)
        
        return exam_schedule
    
    def save_groundtruth_xlsx(self, exam_schedule: List[Dict], output_file: Path):
        """Save groundtruth to Excel"""
        wb = Workbook()
        ws = wb.active
        
        if not exam_schedule:
            print("   ⚠️  No exams in schedule")
            wb.save(output_file)
            return
        
        # Write headers
        headers = list(exam_schedule[0].keys())
        for col_idx, header in enumerate(headers, start=1):
            ws.cell(1, col_idx, header)
            ws.cell(1, col_idx).font = Font(bold=True)
            ws.cell(1, col_idx).fill = PatternFill(start_color="D9E1F2", 
                                                   end_color="D9E1F2", fill_type="solid")
        
        # Write data
        for row_idx, entry in enumerate(exam_schedule, start=2):
            for col_idx, header in enumerate(headers, start=1):
                value = entry[header]
                ws.cell(row_idx, col_idx, value)
        
        # Adjust column widths
        for col_idx, header in enumerate(headers, start=1):
            if col_idx <= 26:
                col_letter = chr(64 + col_idx)
            else:
                col_letter = chr(64 + (col_idx - 1) // 26) + chr(65 + (col_idx - 1) % 26)
            ws.column_dimensions[col_letter].width = max(15, len(header) + 2)
        
        wb.save(output_file)
    
    def generate_exam_schedule_template(self, output_file: Path):
        """Generate empty exam_schedule.xlsx template for agent workspace"""
        wb = Workbook()
        ws = wb.active
        ws.title = "Sheet1"
        
        headers = [
            "Course Code",
            "Course Name",
            "Proctor Name",
            "Proctor Email",
            "Open-book/Closed-book",
            "Final Date (MM/DD/YYYY)",
            "Start Time (HH:MM)",
            "Duration (minutes)",
            "Location",
            "Information Source(Announcement/Email/Message)",
            "Course Credit"
        ]
        
        # Write headers
        for col_idx, header in enumerate(headers, start=1):
            ws.cell(1, col_idx, header)
            ws.cell(1, col_idx).font = Font(bold=True)
            ws.cell(1, col_idx).fill = PatternFill(start_color="D9E1F2", 
                                                   end_color="D9E1F2", fill_type="solid")
        
        # Adjust column widths
        for col_idx, header in enumerate(headers, start=1):
            if col_idx <= 26:
                col_letter = chr(64 + col_idx)
            else:
                col_letter = chr(64 + (col_idx - 1) // 26) + chr(65 + (col_idx - 1) % 26)
            ws.column_dimensions[col_letter].width = max(15, len(header) + 2)
        
        wb.save(output_file)
    
    def generate(self, output_dir: Path) -> bool:
        """Generate all configuration files"""
        try:
            files_dir = output_dir / "files"
            groundtruth_dir = output_dir / "groundtruth_workspace"
            initial_workspace_dir = output_dir / "initial_workspace"
            
            files_dir.mkdir(parents=True, exist_ok=True)
            groundtruth_dir.mkdir(parents=True, exist_ok=True)
            initial_workspace_dir.mkdir(parents=True, exist_ok=True)
            
            print(f"🎲 Generating Canvas exam data...")
            print(f"   Difficulty: {self.difficulty}")
            print(f"   Courses: {self.num_courses}")
            print(f"   Canvas exam rate: {self.canvas_exam_rate:.0%}")
            print(f"   Email exam rate: {self.email_exam_rate:.0%}")
            print(f"   No exam rate: {self.no_exam_rate:.0%}")
            print(f"   TBD rate: {self.tbd_rate:.0%}")
            print(f"   Exemption rate: {self.exemption_rate:.0%}")
            print(f"   Seed: {self.seed}")
            
            # Generate course data
            courses = self.generate_course_data()
            
            print(f"\n📊 Generated {len(courses)} courses:")
            for course in courses:
                print(f"   • {course['course_code']}: {course['name']} ({course['info_source']})")
            
            # Generate Canvas users
            print(f"\n👥 Generating users...")
            users = self.generate_canvas_users(courses)
            users_file = files_dir / "canvas_users.json"
            with open(users_file, 'w', encoding='utf-8') as f:
                json.dump(users, f, indent=2, ensure_ascii=False)
            print(f"   ✅ Saved: {users_file}")
            
            # Generate course config
            print(f"\n📝 Generating course config...")
            course_config = self.generate_course_config(courses)
            course_config_file = files_dir / "course_config.json"
            with open(course_config_file, 'w', encoding='utf-8') as f:
                json.dump(course_config, f, indent=2, ensure_ascii=False)
            print(f"   ✅ Saved: {course_config_file}")
            
            # Generate email config
            print(f"\n📧 Generating email config...")
            email_config = self.generate_email_config(courses)
            email_config_file = files_dir / "email_config.json"
            with open(email_config_file, 'w', encoding='utf-8') as f:
                json.dump(email_config, f, indent=2, ensure_ascii=False)
            email_course_count = len([c for c in courses if c['info_source'] == "email"])
            if email_course_count > 0:
                print(f"   ✅ Saved: {email_config_file} ({email_course_count} email course(s), {self.distraction_emails} distraction(s))")
            else:
                print(f"   ✅ Saved: {email_config_file} (no email courses, {self.distraction_emails} distraction(s) only)")
            
            # Generate email template file
            template_file = files_dir / "exam_notification_template.txt"
            template_content = """Dear {recipient_name},

Hello!

This is an important exam notification email. Please read the following information carefully:

📚 Course Information
Course Name: {course_name}
Exam Type: {exam_type}

📅 Exam Schedule
Exam Date: {exam_date}
Exam Time: {exam_time}
Duration: {duration}

📍 Exam Location
{exam_location}

📧 Contact Information
If you have any questions, please contact your course instructor or send an email to: {sender_email}

Good luck with your exam!

Best regards,

{sender_name}
{sender_email}
Sent at: {send_time}

---
This email was sent automatically by the system. Please do not reply.
If you have any issues, please contact the course administrator.
"""
            with open(template_file, 'w', encoding='utf-8') as f:
                f.write(template_content)
            print(f"   ✅ Saved: {template_file}")
            
            # Generate groundtruth
            print(f"\n🎯 Generating groundtruth...")
            exam_schedule = self.generate_groundtruth(courses)
            groundtruth_file = groundtruth_dir / "exam_schedule.xlsx"
            self.save_groundtruth_xlsx(exam_schedule, groundtruth_file)
            print(f"   ✅ Saved: {groundtruth_file}")
            print(f"   📊 {len(exam_schedule)} exams to attend")
            
            # Generate empty exam schedule template for initial_workspace
            print(f"\n📋 Generating exam schedule template...")
            template_file = initial_workspace_dir / "exam_schedule.xlsx"
            self.generate_exam_schedule_template(template_file)
            print(f"   ✅ Saved: {template_file}")
            
            # Save metadata
            metadata = {
                "num_courses": len(courses),
                "num_enrolled_courses": sum(1 for c in courses if c['info_source'] != 'exempted'),
                "num_exams": len(exam_schedule),
                "canvas_exams": sum(1 for c in courses if c['info_source'] == 'canvas' and not c.get('is_past', False)),
                "email_exams": sum(1 for c in courses if c['info_source'] == 'email' and not c.get('is_past', False)),
                "tbd_exams": sum(1 for c in courses if c.get('is_tbd', False)),
                "past_exams": sum(1 for c in courses if c.get('is_past', False)),
                "exempted_courses": sum(1 for c in courses if c['info_source'] == 'exempted'),
                "no_exam_courses": sum(1 for c in courses if c['info_source'] == 'no_exam'),
                "reference_date": "2025-01-15",
                "difficulty": self.difficulty,
                "seed": self.seed,
                "parameters": {
                    "num_courses": self.num_courses,
                    "canvas_exam_rate": self.canvas_exam_rate,
                    "email_exam_rate": self.email_exam_rate,
                    "no_exam_rate": self.no_exam_rate,
                    "tbd_rate": self.tbd_rate,
                    "exemption_rate": self.exemption_rate,
                    "past_exam_rate": self.past_exam_rate,
                    "distraction_emails": self.distraction_emails,
                    "distraction_announcements": self.distraction_announcements
                }
            }
            
            metadata_file = groundtruth_dir / "metadata.json"
            with open(metadata_file, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=2, ensure_ascii=False)
            print(f"   ✅ Saved: {metadata_file}")
            
            # Print summary
            print(f"\n📊 Generation Summary:")
            print(f"   Total courses: {metadata['num_courses']}")
            print(f"   Enrolled courses: {metadata['num_enrolled_courses']}")
            print(f"   Exams to attend: {metadata['num_exams']} (future exams only)")
            print(f"   Canvas announcements: {metadata['canvas_exams']}")
            print(f"   Email notifications: {metadata['email_exams']}")
            print(f"   TBD exams: {metadata['tbd_exams']}")
            print(f"   Past exams (noise): {metadata['past_exams']}")
            print(f"   Exempted courses: {metadata['exempted_courses']}")
            print(f"   No exam courses: {metadata['no_exam_courses']}")
            
            print(f"\n✅ Canvas exam data generation complete!")
            return True
            
        except Exception as e:
            print(f"❌ Error generating exam data: {e}")
            import traceback
            traceback.print_exc()
            return False


def main():
    parser = ArgumentParser(description="Generate Canvas exam arrangement task data")
    
    parser.add_argument("--output-dir", type=str, required=True,
                       help="Output directory (task root)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed (default: 42)")
    parser.add_argument("--num-courses", type=int, default=10,
                       help="Number of courses (default: 10)")
    parser.add_argument("--canvas-exam-rate", type=float, default=0.7,
                       help="Canvas exam rate (default: 0.7)")
    parser.add_argument("--email-exam-rate", type=float, default=0.2,
                       help="Email exam rate (default: 0.2)")
    parser.add_argument("--no-exam-rate", type=float, default=0.1,
                       help="No exam rate (default: 0.1)")
    parser.add_argument("--tbd-rate", type=float, default=0.2,
                       help="TBD rate (default: 0.2)")
    parser.add_argument("--exemption-rate", type=float, default=0.1,
                       help="Exemption rate (default: 0.1)")
    parser.add_argument("--past-exam-rate", type=float, default=0.15,
                       help="Past exam rate (before Jan 15, 2025, default: 0.15)")
    parser.add_argument("--distraction-emails", type=int, default=3,
                       help="Distraction emails (default: 3)")
    parser.add_argument("--distraction-announcements", type=int, default=2,
                       help="Distraction announcements per course (default: 2)")
    parser.add_argument("--difficulty", type=str, default="custom",
                       choices=["easy", "medium", "hard", "expert", "custom"],
                       help="Difficulty preset (default: custom)")
    
    args = parser.parse_args()
    
    # Apply difficulty presets (only for parameters that were not explicitly set by user)
    # Store defaults to check if user explicitly provided values
    parser_defaults = {
        'num_courses': 10,
        'canvas_exam_rate': 0.7,
        'email_exam_rate': 0.2,
        'no_exam_rate': 0.1,
        'tbd_rate': 0.2,
        'exemption_rate': 0.1,
        'past_exam_rate': 0.15,
        'distraction_emails': 3,
        'distraction_announcements': 2,
    }
    
    if args.difficulty != "custom":
        difficulty_presets = {
            "easy": {
                'num_courses': 5,
                'canvas_exam_rate': 0.8,
                'email_exam_rate': 0.2,
                'no_exam_rate': 0.0,
                'tbd_rate': 0.0,
                'exemption_rate': 0.0,
                'past_exam_rate': 0.0,
                'distraction_emails': 0,
                'distraction_announcements': 0,
            },
            "medium": {
                'num_courses': 10,
                'canvas_exam_rate': 0.7,
                'email_exam_rate': 0.2,
                'no_exam_rate': 0.1,
                'tbd_rate': 0.2,
                'exemption_rate': 0.1,
                'past_exam_rate': 0.15,
                'distraction_emails': 3,
                'distraction_announcements': 2,
            },
            "hard": {
                'num_courses': 15,
                'canvas_exam_rate': 0.6,
                'email_exam_rate': 0.3,
                'no_exam_rate': 0.1,
                'tbd_rate': 0.3,
                'exemption_rate': 0.2,
                'past_exam_rate': 0.2,
                'distraction_emails': 5,
                'distraction_announcements': 3,
            },
            "expert": {
                'num_courses': 20,
                'canvas_exam_rate': 0.5,
                'email_exam_rate': 0.4,
                'no_exam_rate': 0.1,
                'tbd_rate': 0.4,
                'exemption_rate': 0.3,
                'past_exam_rate': 0.25,
                'distraction_emails': 10,
                'distraction_announcements': 5,
            }
        }
        
        if args.difficulty in difficulty_presets:
            preset = difficulty_presets[args.difficulty]
            # Only apply preset values if user didn't explicitly provide them
            for param, preset_value in preset.items():
                current_value = getattr(args, param)
                default_value = parser_defaults.get(param)
                # If current value equals default, use preset; otherwise keep user's value
                if current_value == default_value:
                    setattr(args, param, preset_value)
    
    generator = ExamDataGenerator(
        seed=args.seed,
        num_courses=args.num_courses,
        canvas_exam_rate=args.canvas_exam_rate,
        email_exam_rate=args.email_exam_rate,
        no_exam_rate=args.no_exam_rate,
        tbd_rate=args.tbd_rate,
        exemption_rate=args.exemption_rate,
        past_exam_rate=args.past_exam_rate,
        distraction_emails=args.distraction_emails,
        distraction_announcements=args.distraction_announcements,
        difficulty=args.difficulty
    )
    
    success = generator.generate(Path(args.output_dir))
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

