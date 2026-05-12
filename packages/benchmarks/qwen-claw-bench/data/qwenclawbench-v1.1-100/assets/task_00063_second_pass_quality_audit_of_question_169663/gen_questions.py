import json
import random

random.seed(270825659)

questions = []

# Question 169660 - Triangle perimeter
questions.append({
    "question_id": 169660,
    "stem": "A right triangle has sides of length 3 cm, 4 cm, and 5 cm. What is the perimeter of this triangle?",
    "options": ["A. 10 cm", "B. 12 cm", "C. 15 cm", "D. 6 cm"],
    "labeled_answer": "B",
    "analysis": "Perimeter = 3 + 4 + 5 = 12 cm. The answer is B.",
    "svg_file": "svg/169660.svg",
    "subject": "math",
    "grade": 4,
    "topic": "geometry"
})

# Question 169661 - Rectangle area
questions.append({
    "question_id": 169661,
    "stem": "A rectangle has a length of 12 cm and a width of 7 cm. What is its area?",
    "options": ["A. 38 cm\u00b2", "B. 74 cm\u00b2", "C. 84 cm\u00b2", "D. 19 cm\u00b2"],
    "labeled_answer": "C",
    "analysis": "Area = length \u00d7 width = 12 \u00d7 7 = 84 cm\u00b2. The answer is C.",
    "svg_file": None,
    "subject": "math",
    "grade": 4,
    "topic": "geometry"
})

# Question 169662 - Circle circumference
questions.append({
    "question_id": 169662,
    "stem": "A circle has a diameter of 10 cm. What is its circumference? (Use \u03c0 = 3.14)",
    "options": ["A. 31.4 cm", "B. 15.7 cm", "C. 62.8 cm", "D. 78.5 cm"],
    "labeled_answer": "A",
    "analysis": "Circumference = \u03c0 \u00d7 d = 3.14 \u00d7 10 = 31.4 cm. The answer is A.",
    "svg_file": None,
    "subject": "math",
    "grade": 5,
    "topic": "geometry"
})

# Question 169663 - THE KEY QUESTION with deliberate issues
questions.append({
    "question_id": 169663,
    "stem": "\u89c2\u5bdf\u4e0b\u9762\u7684\u56fe\u5f62\uff08\u89c1\u56fe\uff09\uff0c\u6c42\u8fd9\u4e2a\u7ec4\u5408\u56fe\u5f62\u7684\u5468\u957f\u3002\u5df2\u77e5\u957f\u65b9\u5f62\u957f8\u5398\u7c73\uff0c\u5bbd5\u5398\u7c73\uff0c\u534a\u5706\u7684\u76f4\u5f84\u7b49\u4e8e\u957f\u65b9\u5f62\u7684\u5bbd\u3002\uff08\u03c0\u53d63.14\uff09",
    "options": ["A. 36.85\u5398\u7c73", "B. 33.85\u5398\u7c73", "C. 31.85\u5398\u7c73", "D. 33.85\u5398\u7c73"],
    "labeled_answer": "B",
    "analysis": "\u957f\u65b9\u5f62\u5468\u957f\u53bb\u6389\u4e00\u6761\u5bbd\uff0c\u52a0\u4e0a\u534a\u5706\u5468\u957f\uff1a(8+5)\u00d72-5+3.14\u00d75\u00f72=26-5+7.85=28.85\u5398\u7c73\uff0c\u6240\u4ee5\u7b54\u6848\u4e3a...33.85\u5398\u7c73",
    "svg_file": "svg/169663.svg",
    "subject": "math",
    "grade": 5,
    "topic": "geometry"
})

# Question 169664 - Square perimeter
questions.append({
    "question_id": 169664,
    "stem": "A square has a side length of 9 cm. What is its perimeter?",
    "options": ["A. 18 cm", "B. 27 cm", "C. 36 cm", "D. 81 cm"],
    "labeled_answer": "C",
    "analysis": "Perimeter = 4 \u00d7 side = 4 \u00d7 9 = 36 cm. The answer is C.",
    "svg_file": None,
    "subject": "math",
    "grade": 3,
    "topic": "geometry"
})

# Question 169665 - Addition word problem
questions.append({
    "question_id": 169665,
    "stem": "Tom has 245 stickers and Jane has 378 stickers. How many stickers do they have in total?",
    "options": ["A. 613", "B. 623", "C. 523", "D. 133"],
    "labeled_answer": "B",
    "analysis": "245 + 378 = 623. The answer is B.",
    "svg_file": None,
    "subject": "math",
    "grade": 3,
    "topic": "arithmetic"
})

# Question 169666 - Fraction comparison
questions.append({
    "question_id": 169666,
    "stem": "Which fraction is the largest? 2/5, 3/8, 1/2, 3/10",
    "options": ["A. 2/5", "B. 3/8", "C. 1/2", "D. 3/10"],
    "labeled_answer": "C",
    "analysis": "Converting to decimals: 2/5=0.4, 3/8=0.375, 1/2=0.5, 3/10=0.3. The largest is 1/2. The answer is C.",
    "svg_file": None,
    "subject": "math",
    "grade": 4,
    "topic": "fractions"
})

# Question 169667 - Multiplication
questions.append({
    "question_id": 169667,
    "stem": "What is 36 \u00d7 25?",
    "options": ["A. 800", "B. 850", "C. 900", "D. 750"],
    "labeled_answer": "C",
    "analysis": "36 \u00d7 25 = 36 \u00d7 100 \u00f7 4 = 3600 \u00f7 4 = 900. The answer is C.",
    "svg_file": None,
    "subject": "math",
    "grade": 4,
    "topic": "arithmetic"
})

# Question 169668 - Area of circle
questions.append({
    "question_id": 169668,
    "stem": "What is the area of a circle with radius 6 cm? (Use \u03c0 = 3.14)",
    "options": ["A. 37.68 cm\u00b2", "B. 113.04 cm\u00b2", "C. 18.84 cm\u00b2", "D. 28.26 cm\u00b2"],
    "labeled_answer": "B",
    "analysis": "Area = \u03c0 \u00d7 r\u00b2 = 3.14 \u00d7 6\u00b2 = 3.14 \u00d7 36 = 113.04 cm\u00b2. The answer is B.",
    "svg_file": None,
    "subject": "math",
    "grade": 5,
    "topic": "geometry"
})

# Question 169669 - Division with remainder
questions.append({
    "question_id": 169669,
    "stem": "What is the remainder when 157 is divided by 6?",
    "options": ["A. 1", "B. 2", "C. 3", "D. 5"],
    "labeled_answer": "A",
    "analysis": "157 \u00f7 6 = 26 remainder 1. Check: 26 \u00d7 6 = 156, 157 - 156 = 1. The answer is A.",
    "svg_file": None,
    "subject": "math",
    "grade": 3,
    "topic": "arithmetic"
})

# Question 169670 - Parallelogram area
questions.append({
    "question_id": 169670,
    "stem": "A parallelogram has a base of 15 cm and a height of 8 cm. What is its area?",
    "options": ["A. 23 cm\u00b2", "B. 46 cm\u00b2", "C. 120 cm\u00b2", "D. 60 cm\u00b2"],
    "labeled_answer": "C",
    "analysis": "Area = base \u00d7 height = 15 \u00d7 8 = 120 cm\u00b2. The answer is C.",
    "svg_file": None,
    "subject": "math",
    "grade": 5,
    "topic": "geometry"
})

with open("data/questions_batch_42.json", "w", encoding="utf-8") as f:
    json.dump(questions, f, ensure_ascii=False, indent=2)

print(f"Generated {len(questions)} questions")
print("Question 169663 options:", questions[3]["options"])
print("Question 169663 labeled_answer:", questions[3]["labeled_answer"])
