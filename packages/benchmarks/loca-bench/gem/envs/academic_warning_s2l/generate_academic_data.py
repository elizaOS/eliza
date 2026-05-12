#!/usr/bin/env python3
"""
Academic Warning Data Generator
Generates synthetic student score data for academic warning system testing.
"""

import numpy as np
import pandas as pd
import argparse
from pathlib import Path
import random
from typing import List, Tuple


class AcademicDataGenerator:
    """Generate synthetic academic warning data"""
    
    # Pool of first and last names for generating realistic student names
    FIRST_NAMES = [
        "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda",
        "William", "Barbara", "David", "Elizabeth", "Richard", "Susan", "Joseph", "Jessica",
        "Thomas", "Sarah", "Charles", "Karen", "Christopher", "Nancy", "Daniel", "Lisa",
        "Matthew", "Betty", "Anthony", "Margaret", "Mark", "Sandra", "Donald", "Ashley",
        "Steven", "Kimberly", "Paul", "Emily", "Andrew", "Donna", "Joshua", "Michelle",
        "Kenneth", "Dorothy", "Kevin", "Carol", "Brian", "Amanda", "George", "Melissa",
        "Edward", "Deborah", "Ronald", "Stephanie", "Timothy", "Rebecca", "Jason", "Sharon",
        "Jeffrey", "Laura", "Ryan", "Cynthia", "Jacob", "Kathleen", "Gary", "Amy",
        "Nicholas", "Shirley", "Eric", "Angela", "Jonathan", "Helen", "Stephen", "Anna",
        "Larry", "Brenda", "Justin", "Pamela", "Scott", "Nicole", "Brandon", "Emma",
        "Benjamin", "Samantha", "Samuel", "Katherine", "Raymond", "Christine", "Gregory", "Debra",
        "Frank", "Rachel", "Alexander", "Catherine", "Patrick", "Carolyn", "Jack", "Janet",
        "Dennis", "Ruth", "Jerry", "Maria", "Tyler", "Heather", "Aaron", "Diane",
        "Jose", "Virginia", "Adam", "Julie", "Henry", "Joyce", "Nathan", "Victoria",
        "Douglas", "Olivia", "Zachary", "Kelly", "Peter", "Christina", "Kyle", "Lauren",
        "Walter", "Joan", "Ethan", "Evelyn", "Jeremy", "Judith", "Harold", "Megan",
        "Keith", "Cheryl", "Christian", "Andrea", "Roger", "Hannah", "Noah", "Martha",
        "Gerald", "Jacqueline", "Carl", "Frances", "Terry", "Gloria", "Sean", "Ann",
        "Austin", "Teresa", "Arthur", "Kathryn", "Lawrence", "Sara", "Jesse", "Janice",
        "Dylan", "Jean", "Bryan", "Alice", "Joe", "Madison", "Jordan", "Doris",
        "Billy", "Abigail", "Bruce", "Julia", "Albert", "Judy", "Willie", "Grace",
        "Gabriel", "Denise", "Logan", "Amber", "Alan", "Marilyn", "Juan", "Beverly"
    ]
    
    LAST_NAMES = [
        "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
        "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas",
        "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson", "White",
        "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker", "Young",
        "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
        "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell",
        "Carter", "Roberts", "Gomez", "Phillips", "Evans", "Turner", "Diaz", "Parker",
        "Cruz", "Edwards", "Collins", "Reyes", "Stewart", "Morris", "Morales", "Murphy",
        "Cook", "Rogers", "Gutierrez", "Ortiz", "Morgan", "Cooper", "Peterson", "Bailey",
        "Reed", "Kelly", "Howard", "Ramos", "Kim", "Cox", "Ward", "Richardson",
        "Watson", "Brooks", "Chavez", "Wood", "James", "Bennett", "Gray", "Mendoza",
        "Ruiz", "Hughes", "Price", "Alvarez", "Castillo", "Sanders", "Patel", "Myers",
        "Long", "Ross", "Foster", "Jimenez", "Powell", "Jenkins", "Perry", "Russell",
        "Sullivan", "Bell", "Coleman", "Butler", "Henderson", "Barnes", "Gonzales", "Fisher",
        "Vasquez", "Simmons", "Romero", "Jordan", "Patterson", "Alexander", "Hamilton", "Graham",
        "Reynolds", "Griffin", "Wallace", "Moreno", "West", "Cole", "Hayes", "Bryant"
    ]
    
    def __init__(self, num_students: int = 150, num_historical_exams: int = 7,
                 seed: int = 42, difficulty: str = "medium"):
        """
        Initialize the data generator
        
        Args:
            num_students: Number of students to generate
            num_historical_exams: Number of historical exam files
            seed: Random seed for reproducibility
            difficulty: Difficulty level (easy/medium/hard)
                       - easy: fewer at-risk students, smaller drops
                       - medium: moderate number of at-risk students
                       - hard: more at-risk students, larger drops
        """
        self.num_students = num_students
        self.num_historical_exams = num_historical_exams
        self.seed = seed
        self.difficulty = difficulty
        
        np.random.seed(seed)
        random.seed(seed)
        
        # Set difficulty parameters
        if difficulty == "easy":
            self.drop_probability = 0.15  # 15% of students have drops
            self.critical_ratio = 0.25    # 25% of drops are critical (>45%)
            self.drop_range = (0.25, 0.50)  # Drop ratio range
        elif difficulty == "hard":
            self.drop_probability = 0.30  # 30% of students have drops
            self.critical_ratio = 0.40    # 40% of drops are critical
            self.drop_range = (0.25, 0.65)
        else:  # medium
            self.drop_probability = 0.20  # 20% of students have drops
            self.critical_ratio = 0.30    # 30% of drops are critical
            self.drop_range = (0.25, 0.55)
    
    def generate_student_names(self) -> List[Tuple[str, str]]:
        """Generate unique student IDs and names"""
        students = []
        used_names = set()
        
        for i in range(self.num_students):
            # Generate unique student ID
            student_id = f"S{i+1:03d}"
            
            # Generate unique name
            while True:
                first = random.choice(self.FIRST_NAMES)
                last = random.choice(self.LAST_NAMES)
                full_name = f"{first} {last}"
                if full_name not in used_names:
                    used_names.add(full_name)
                    break
            
            students.append((student_id, full_name))
        
        return students
    
    def generate_class_assignments(self, students: List[Tuple[str, str]]) -> dict:
        """Assign students to classes (A, B, C, etc.)"""
        num_classes = max(3, self.num_students // 50)  # At least 3 classes
        classes = [chr(65 + i) for i in range(num_classes)]  # A, B, C, ...
        
        assignments = {}
        for student_id, name in students:
            assignments[student_id] = random.choice(classes)
        
        return assignments
    
    def generate_historical_scores(self, students: List[Tuple[str, str]],
                                   classes: dict) -> List[pd.DataFrame]:
        """Generate historical exam scores"""
        historical_dfs = []
        
        # Generate baseline ability for each student (stays consistent)
        student_abilities = {}
        for student_id, name in students:
            # Base ability: normally distributed around 75, std 15
            base_ability = np.clip(np.random.normal(75, 15), 40, 100)
            student_abilities[student_id] = base_ability
        
        # Generate each historical exam
        for exam_num in range(self.num_historical_exams):
            rows = []
            for student_id, name in students:
                base_score = student_abilities[student_id]
                # Add some random variation for each exam (±10 points)
                score = np.clip(base_score + np.random.normal(0, 8), 0, 100)
                score = round(score, 1)
                
                rows.append({
                    'student_id': student_id,
                    'name': name,
                    'class_id': classes[student_id],
                    'score': score
                })
            
            df = pd.DataFrame(rows)
            historical_dfs.append(df)
        
        return historical_dfs, student_abilities
    
    def generate_latest_scores(self, students: List[Tuple[str, str]],
                               classes: dict, historical_avg: dict) -> Tuple[pd.DataFrame, pd.DataFrame]:
        """
        Generate latest exam scores with some students having significant drops
        
        Args:
            students: List of (student_id, name) tuples
            classes: Dict mapping student_id to class_id
            historical_avg: Dict mapping student_id to their actual historical average score
        
        Returns:
            latest_scores_df: DataFrame with latest scores
            groundtruth_df: DataFrame with expected alerts (students with drops >25%)
        """
        rows = []
        groundtruth_rows = []
        
        # Determine which students will have score drops
        num_drop_students = int(self.num_students * self.drop_probability)
        drop_student_indices = random.sample(range(len(students)), num_drop_students)
        
        # Among drop students, determine which are critical
        num_critical = int(num_drop_students * self.critical_ratio)
        critical_indices = drop_student_indices[:num_critical]
        warning_indices = drop_student_indices[num_critical:]
        
        for idx, (student_id, name) in enumerate(students):
            hist_avg = historical_avg[student_id]
            
            if idx in critical_indices:
                # Critical drop: 45-65% drop from historical average
                drop_ratio = np.random.uniform(0.45, self.drop_range[1])
                current_score = hist_avg * (1 - drop_ratio)
            elif idx in warning_indices:
                # Warning drop: 25-45% drop from historical average
                drop_ratio = np.random.uniform(self.drop_range[0], 0.45)
                current_score = hist_avg * (1 - drop_ratio)
            else:
                # Normal performance: within ±15% of historical average
                drop_ratio = np.random.uniform(-0.15, 0.20)
                current_score = hist_avg * (1 - drop_ratio)
            
            current_score = round(np.clip(current_score, 0, 100), 1)
            actual_drop_ratio = (hist_avg - current_score) / hist_avg
            
            rows.append({
                'student_id': student_id,
                'name': name,
                'class_id': classes[student_id],
                'score': current_score
            })
            
            # Add to groundtruth if drop > 25%
            if actual_drop_ratio > 0.25:
                groundtruth_rows.append({
                    'student_id': student_id,
                    'name': name,
                    'score': current_score,
                    'hist_avg': hist_avg,
                    'drop_ratio': actual_drop_ratio
                })
        
        latest_df = pd.DataFrame(rows)
        groundtruth_df = pd.DataFrame(groundtruth_rows).sort_values('drop_ratio', ascending=False)
        
        return latest_df, groundtruth_df
    
    def generate_all_data(self, output_dir: Path, save_groundtruth: bool = False):
        """Generate all data files"""
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        print(f"Generating academic warning data...")
        print(f"  Students: {self.num_students}")
        print(f"  Historical exams: {self.num_historical_exams}")
        print(f"  Difficulty: {self.difficulty}")
        print(f"  Seed: {self.seed}")
        print()
        
        # Generate students
        students = self.generate_student_names()
        classes = self.generate_class_assignments(students)
        
        # Generate historical scores
        print("Generating historical exam data...")
        historical_dfs, student_abilities = self.generate_historical_scores(students, classes)
        
        # Save historical exam files
        for i, df in enumerate(historical_dfs):
            exam_id = 2501 + i  # Start from 2501
            filename = output_dir / f"scores_{exam_id}.csv"
            df.to_csv(filename, index=False)
            print(f"  ✓ Saved {filename.name} ({len(df)} students)")
        
        # Calculate actual historical averages from generated data
        print("\nCalculating historical averages...")
        combined_historical = pd.concat(historical_dfs, ignore_index=True)
        historical_avg_df = combined_historical.groupby('student_id')['score'].mean()
        historical_avg = historical_avg_df.to_dict()
        
        # Generate latest scores using actual historical averages
        print("Generating latest exam data...")
        latest_df, groundtruth_df = self.generate_latest_scores(students, classes, historical_avg)
        
        # Save latest scores to initial_workspace
        initial_workspace = output_dir.parent / "initial_workspace"
        initial_workspace.mkdir(parents=True, exist_ok=True)
        latest_file = initial_workspace / "latest_quiz_scores.csv"
        latest_df.to_csv(latest_file, index=False)
        print(f"  ✓ Saved {latest_file.name} ({len(latest_df)} students)")
        
        # Save groundtruth
        if save_groundtruth:
            groundtruth_workspace = output_dir.parent / "groundtruth_workspace"
            groundtruth_workspace.mkdir(parents=True, exist_ok=True)
            groundtruth_file = groundtruth_workspace / "expected_alerts.csv"
            groundtruth_df.to_csv(groundtruth_file, index=False)
            print(f"  ✓ Saved {groundtruth_file.name} ({len(groundtruth_df)} students)")
        
        # Print statistics
        print("\n" + "=" * 60)
        print("Data Generation Statistics")
        print("=" * 60)
        print(f"Total students: {len(students)}")
        print(f"Students with >25% drop (warnings): {len(groundtruth_df)}")
        critical_count = len(groundtruth_df[groundtruth_df['drop_ratio'] > 0.45])
        print(f"Students with >45% drop (critical): {critical_count}")
        print(f"Students performing normally: {len(students) - len(groundtruth_df)}")
        
        if len(groundtruth_df) > 0:
            print(f"\nDrop ratio range: {groundtruth_df['drop_ratio'].min():.1%} - {groundtruth_df['drop_ratio'].max():.1%}")
            print(f"Mean drop ratio: {groundtruth_df['drop_ratio'].mean():.1%}")


def main():
    parser = argparse.ArgumentParser(description="Generate academic warning test data")
    
    parser.add_argument("--num-students", type=int, default=150,
                       help="Number of students to generate (default: 150)")
    parser.add_argument("--num-exams", type=int, default=7,
                       help="Number of historical exams (default: 7)")
    parser.add_argument("--difficulty", type=str, default="medium",
                       choices=["easy", "medium", "hard"],
                       help="Difficulty level (default: medium)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed for reproducibility (default: 42)")
    parser.add_argument("--output-dir", type=str, default="files",
                       help="Output directory for generated files (default: files)")
    parser.add_argument("--save-groundtruth", action="store_true",
                       help="Save groundtruth expected_alerts.csv file")
    
    args = parser.parse_args()
    
    # Generate data
    generator = AcademicDataGenerator(
        num_students=args.num_students,
        num_historical_exams=args.num_exams,
        seed=args.seed,
        difficulty=args.difficulty
    )
    
    generator.generate_all_data(
        output_dir=args.output_dir,
        save_groundtruth=args.save_groundtruth
    )
    
    print("\n✅ Data generation complete!")


if __name__ == "__main__":
    main()

