#!/usr/bin/env python3
"""
Simple test to verify that the evaluation system works properly
"""

import sys
import os

# Add path to import the main module
sys.path.append(os.path.dirname(__file__))

def test_evaluation():
    """Test the evaluation system"""
    print("Testing Academic Warning System Evaluation...")

    # Set the test workspace path
    workspace_path = "../initial_workspace"
    
    try:
        from main import AcademicWarningEvaluator
        
        # Create evaluator instance
        evaluator = AcademicWarningEvaluator(workspace_path)

        # Test loading expected warnings
        print("Testing expected warnings loading...")
        if evaluator.load_expected_warnings():
            print(f"✓ Successfully loaded {len(evaluator.expected_warnings)} expected warnings")
            
            # Display a few examples of expected warnings
            for i, warning in enumerate(evaluator.expected_warnings[:3]):
                print(f"  Example {i+1}: {warning['student_id']} - {warning['decline_pct']}% decline")
        else:
            print("✗ Failed to load expected warnings")
            return False
        
        # Test extracting actual warnings (no actual logs here, so it will be empty)
        print("\nTesting actual warnings extraction...")
        if evaluator.extract_actual_warnings():
            print(f"✓ Successfully extracted {len(evaluator.actual_warnings)} actual warnings")
        else:
            print("✗ Failed to extract actual warnings")
            return False
        
        # Test performance evaluation
        print("\nTesting performance evaluation...")
        results = evaluator.evaluate_performance()
        
        print(f"✓ Evaluation completed:")
        print(f"  Expected warnings: {results['expected_warnings_count']}")
        print(f"  Actual warnings: {results['actual_warnings_count']}")
        print(f"  Precision: {results['accuracy_metrics']['precision']:.3f}")
        print(f"  Recall: {results['accuracy_metrics']['recall']:.3f}")
        print(f"  F1 Score: {results['accuracy_metrics']['f1_score']:.3f}")
        
        # Test report generation
        print("\nTesting report generation...")
        report = evaluator.generate_report(results)
        print("✓ Report generated successfully")
        print(f"  Report length: {len(report)} characters")
        
        return True
        
    except Exception as e:
        print(f"✗ Test failed with error: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = test_evaluation()
    print(f"\n{'='*50}")
    if success:
        print("✓ All tests passed! Evaluation system is ready.")
    else:
        print("✗ Some tests failed. Please check the evaluation system.")
    print(f"{'='*50}")