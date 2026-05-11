"""
Canvas Arrange Exam S2L Environment

This environment simulates a Canvas LMS scenario where students need to organize
exam information from Canvas announcements and emails into an Excel spreadsheet.
"""

from pathlib import Path

# # Import the environment class
# try:
#     # Try importing with hyphenated module name
#     import importlib.util
#     spec = importlib.util.spec_from_file_location(
#         "canvas_arrange_exam_s2l",
#         Path(__file__).parent / "canvas-arrange-exam-s2l.py"
#     )
#     module = importlib.util.module_from_spec(spec)
#     spec.loader.exec_module(module)
#     CanvasArrangeExamS2LEnv = module.CanvasArrangeExamS2LEnv
# except Exception as e:
#     print(f"Warning: Could not import CanvasArrangeExamS2LEnv: {e}")
#     CanvasArrangeExamS2LEnv = None

from .canvas_arrange_exam_s2l import CanvasArrangeExamS2LEnv
__all__ = ['CanvasArrangeExamS2LEnv']

