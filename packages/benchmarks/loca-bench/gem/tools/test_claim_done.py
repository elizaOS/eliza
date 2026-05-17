#!/usr/bin/env python
"""
Test script for ClaimDoneTool

This script tests the functionality of the ClaimDoneTool.
"""

import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from gem.tools.claim_done_tool import ClaimDoneTool

print("=" * 80)
print("ClaimDoneTool Test")
print("=" * 80)

# Initialize tool
tool = ClaimDoneTool()

print("\n1. Testing instruction string:")
print("-" * 80)
print(tool.instruction_string())

# Test cases
test_cases = [
    {
        "name": "Self-closing tag",
        "action": "<claim_done />",
        "should_succeed": True
    },
    {
        "name": "With closing tag",
        "action": "<claim_done></claim_done>",
        "should_succeed": True
    },
    {
        "name": "With content inside",
        "action": "<claim_done>Task completed successfully!</claim_done>",
        "should_succeed": True
    },
    {
        "name": "Mixed with other text",
        "action": "I have finished the task. <claim_done /> All requirements are met.",
        "should_succeed": True
    },
    {
        "name": "Case insensitive",
        "action": "<CLAIM_DONE />",
        "should_succeed": True
    },
    {
        "name": "Invalid tag",
        "action": "<done />",
        "should_succeed": False
    },
    {
        "name": "No tag",
        "action": "Task is done",
        "should_succeed": False
    },
]

print("\n2. Testing action execution:")
print("-" * 80)

passed = 0
failed = 0

for i, test in enumerate(test_cases, 1):
    print(f"\nTest {i}: {test['name']}")
    print(f"Action: {test['action']}")
    
    is_valid, has_error, observation, parsed_action = tool.execute_action(test['action'])
    
    expected_valid = test['should_succeed']
    
    if is_valid == expected_valid:
        print(f"✅ PASS - is_valid={is_valid} (expected={expected_valid})")
        passed += 1
        
        if is_valid:
            print(f"Parsed action: {parsed_action}")
            print(f"Has error: {has_error}")
            print(f"Observation preview: {observation[:100]}...")
    else:
        print(f"❌ FAIL - is_valid={is_valid} (expected={expected_valid})")
        failed += 1

print("\n" + "=" * 80)
print(f"Test Summary: {passed} passed, {failed} failed out of {len(test_cases)} tests")
print("=" * 80)

# Full execution example
print("\n3. Full execution example:")
print("-" * 80)
action = "I have completed all the tasks. <claim_done />"
is_valid, has_error, observation, parsed_action = tool.execute_action(action)

print(f"Action: {action}")
print(f"Is valid: {is_valid}")
print(f"Has error: {has_error}")
print(f"Parsed action: {parsed_action}")
print(f"\nObservation:\n{observation}")

if passed == len(test_cases):
    print("\n✅ All tests passed!")
    sys.exit(0)
else:
    print(f"\n⚠️  {failed} test(s) failed")
    sys.exit(1)

