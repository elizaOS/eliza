#!/usr/bin/env python3
"""
Test script for PPTX file comparison using compare_pptx_files method
Based on evaluation configuration from 08aced46-45a2-48d7-993b-ed3fb5b32302.json
"""

import sys
import os
import logging
from pathlib import Path

# Add the project root to Python path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

# Import the compare_pptx_files function directly from slides.py
try:
    from desktop_env.evaluators.metrics.slides import compare_pptx_files, enable_debug_logging
    print(f"Successfully imported compare_pptx_files from {project_root}/desktop_env/evaluators/metrics/slides.py")
except ImportError as e:
    print(f"Error importing compare_pptx_files: {e}")
    print(f"Project root: {project_root}")
    print(f"Python path: {sys.path}")
    sys.exit(1)

def setup_logging():
    """Setup comprehensive logging for debugging"""
    # Configure root logger
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler('pptx_comparison_debug.log', mode='w')
        ]
    )
    
    # Configure slides module loggers to ensure we capture all debug output
    slides_logger = logging.getLogger("desktopenv.metric.slides")
    slides_logger.setLevel(logging.DEBUG)
    
    slides_debug_logger = logging.getLogger("desktopenv.metric.slides.debug")
    slides_debug_logger.setLevel(logging.DEBUG)
    
    # Enable specific debug logging for slides module
    enable_debug_logging()
    
    logger = logging.getLogger(__name__)
    logger.info("=== PPTX Comparison Test Started ===")
    logger.info(f"Slides logger level: {slides_logger.level}")
    logger.info(f"Slides debug logger level: {slides_debug_logger.level}")
    logger.info(f"Slides debug logger handlers: {len(slides_debug_logger.handlers)}")
    return logger

def test_pptx_comparison():
    """
    Test PPTX file comparison using the exact compare_pptx_files function from slides.py
    This directly calls the function from desktop_env/evaluators/metrics/slides.py
    """
    logger = setup_logging()
    
    # Test file paths (you need to place these files in the temp directory)
    test_dir = Path(__file__).parent
    user_file = test_dir / "22_6.pptx"  # User's modified file
    gold_file1 = test_dir / "22_6_Gold.pptx"  # First gold standard
    gold_file2 = test_dir / "22_6_Gold2.pptx"  # Second gold standard
    
    logger.info(f"Test directory: {test_dir}")
    logger.info(f"Looking for files:")
    logger.info(f"  User file: {user_file}")
    logger.info(f"  Gold file 1: {gold_file1}")
    logger.info(f"  Gold file 2: {gold_file2}")
    
    # Check if files exist
    files_exist = True
    for file_path in [user_file, gold_file1, gold_file2]:
        if not file_path.exists():
            logger.error(f"File not found: {file_path}")
            files_exist = False
        else:
            logger.info(f"File found: {file_path} (size: {file_path.stat().st_size} bytes)")
    
    if not files_exist:
        logger.error("Missing required test files. Please place the following files in the temp directory:")
        logger.error("  - 22_6.pptx (user's modified file)")
        logger.error("  - 22_6_Gold.pptx (first gold standard)")
        logger.error("  - 22_6_Gold2.pptx (second gold standard)")
        return False
    
    logger.info("=== Starting PPTX Comparison Tests (Direct Function Call) ===")
    
    # Test 1: Compare user file with first gold standard using default options
    logger.info("\n=== TEST 1: User file vs Gold file 1 (Default Options) ===")
    try:
        # Call the exact function from slides.py with default parameters
        result1 = compare_pptx_files(str(user_file), str(gold_file1))
        logger.info(f"Comparison result 1: {result1}")
        if result1 == 1:
            logger.info("Files match perfectly!")
        else:
            logger.warning("Files do not match")
    except Exception as e:
        logger.error(f"Error in comparison 1: {e}")
        import traceback
        traceback.print_exc()
        result1 = 0
    
    # Test 2: Compare user file with second gold standard using default options
    logger.info("\n=== TEST 2: User file vs Gold file 2 (Default Options) ===")
    try:
        # Call the exact function from slides.py with default parameters
        result2 = compare_pptx_files(str(user_file), str(gold_file2))
        logger.info(f"Comparison result 2: {result2}")
        if result2 == 1:
            logger.info("Files match perfectly!")
        else:
            logger.warning("Files do not match")
    except Exception as e:
        logger.error(f"Error in comparison 2: {e}")
        import traceback
        traceback.print_exc()
        result2 = 0
    
    # Final evaluation (OR logic as in the original config)
    final_result = result1 or result2
    logger.info("\n=== FINAL EVALUATION (Exact Evaluation Logic) ===")
    logger.info(f"Result 1 (vs Gold1): {result1}")
    logger.info(f"Result 2 (vs Gold2): {result2}")
    logger.info(f"Final result (OR logic): {final_result}")
    
    if final_result:
        logger.info("EVALUATION PASSED: User file matches at least one gold standard")
    else:
        logger.warning("EVALUATION FAILED: User file does not match any gold standard")
        logger.warning("The compare_pptx_files function returned 0, indicating files don't match.")
    
    # Additional debugging: Test with debug enabled
    logger.info("\n=== ADDITIONAL TEST: With Debug Enabled ===")
    debug_options = {
        'enable_debug': True
    }
    
    try:
        debug_result1 = compare_pptx_files(
            str(user_file),
            str(gold_file1),
            **debug_options
        )
        debug_result2 = compare_pptx_files(
            str(user_file),
            str(gold_file2),
            **debug_options
        )
        debug_final = debug_result1 or debug_result2
        
        logger.info(f"Debug comparison results: {debug_result1} | {debug_result2} = {debug_final}")
        
    except Exception as e:
        logger.error(f"Error in debug comparison: {e}")
    
    logger.info("\n=== Test Completed ===")
    logger.info(f"Debug log saved to: {test_dir / 'pptx_comparison_debug.log'}")
    
    return final_result

def main():
    """Main test function"""
    print("PPTX Comparison Test Script")
    print("=" * 50)
    
    success = test_pptx_comparison()
    
    print("\n" + "=" * 50)
    if success:
        print("Test completed successfully - files match!")
        sys.exit(0)
    else:
        print("Test completed - files do not match")
        sys.exit(1)

if __name__ == "__main__":
    main()