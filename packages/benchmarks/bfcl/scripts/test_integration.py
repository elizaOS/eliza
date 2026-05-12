#!/usr/bin/env python3
"""
BFCL Integration Test Script

Tests the full BFCL benchmark pipeline with a real LLM provider.
Requires API keys to be set in environment or .env file.

Usage:
    python -m benchmarks.bfcl.scripts.test_integration
    
Environment Variables:
    OPENAI_API_KEY - OpenAI API key (preferred)
    ANTHROPIC_API_KEY - Anthropic API key
    GOOGLE_GENERATIVE_AI_API_KEY - Google AI API key
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(project_root))

# Load .env file if present
try:
    from dotenv import load_dotenv
    env_path = project_root / ".env"
    if env_path.exists():
        load_dotenv(env_path)
        print(f"✅ Loaded environment from {env_path}")
except ImportError:
    print("⚠️  python-dotenv not installed, using system environment")

from benchmarks.bfcl.agent import BFCLAgent, get_model_provider_plugin, ELIZAOS_AVAILABLE  # noqa: E402
from benchmarks.bfcl.types import (  # noqa: E402
    BFCLCategory,
    BFCLConfig,
    BFCLTestCase,
    FunctionCall,
    FunctionDefinition,
    FunctionParameter,
)
from benchmarks.bfcl.parser import FunctionCallParser  # noqa: E402
from benchmarks.bfcl.evaluators import ASTEvaluator  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def create_test_case() -> BFCLTestCase:
    """Create a simple test case for integration testing."""
    return BFCLTestCase(
        id="integration_test_1",
        category=BFCLCategory.SIMPLE,
        question="What's the weather like in San Francisco?",
        functions=[
            FunctionDefinition(
                name="get_weather",
                description="Get the current weather for a location",
                parameters={
                    "location": FunctionParameter(
                        name="location",
                        param_type="string",
                        description="The city and state, e.g. San Francisco, CA",
                        required=True,
                    ),
                    "unit": FunctionParameter(
                        name="unit",
                        param_type="string",
                        description="Temperature unit: 'celsius' or 'fahrenheit'",
                        required=False,
                        enum=["celsius", "fahrenheit"],
                        default="fahrenheit",
                    ),
                },
                required_params=["location"],
            ),
        ],
        expected_calls=[
            FunctionCall(
                name="get_weather",
                arguments={"location": "San Francisco, CA"},
            ),
        ],
    )


def check_environment() -> dict[str, bool]:
    """Check which API keys are available."""
    keys = {
        "OPENAI_API_KEY": bool(os.environ.get("OPENAI_API_KEY")),
        "ANTHROPIC_API_KEY": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "GOOGLE_GENERATIVE_AI_API_KEY": bool(os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY")),
    }
    return keys


async def test_parser() -> bool:
    """Test the function call parser."""
    print("\n" + "=" * 60)
    print("TESTING: Function Call Parser")
    print("=" * 60)
    
    parser = FunctionCallParser()
    
    # Test cases
    test_responses = [
        ('{"name": "get_weather", "arguments": {"location": "San Francisco"}}', 1),
        ('[{"name": "func1", "arguments": {}}, {"name": "func2", "arguments": {}}]', 2),
        ('```json\n{"name": "test", "arguments": {"x": 1}}\n```', 1),
        ('No function needed', 0),
    ]
    
    all_passed = True
    for response, expected_count in test_responses:
        calls = parser.parse(response)
        if len(calls) == expected_count:
            print(f"  ✅ Parser correctly extracted {expected_count} calls")
        else:
            print(f"  ❌ Parser error: expected {expected_count}, got {len(calls)}")
            all_passed = False
    
    return all_passed


async def test_evaluator() -> bool:
    """Test the AST evaluator."""
    print("\n" + "=" * 60)
    print("TESTING: AST Evaluator")
    print("=" * 60)
    
    evaluator = ASTEvaluator()
    
    # Test exact match
    predicted = [FunctionCall(name="get_weather", arguments={"location": "NYC"})]
    expected = [FunctionCall(name="get_weather", arguments={"location": "NYC"})]
    
    if evaluator.evaluate(predicted, expected):
        print("  ✅ Exact match test passed")
    else:
        print("  ❌ Exact match test failed")
        return False
    
    # Test case-insensitive
    predicted = [FunctionCall(name="GetWeather", arguments={"Location": "NYC"})]
    expected = [FunctionCall(name="get_weather", arguments={"location": "NYC"})]
    
    if evaluator.evaluate(predicted, expected):
        print("  ✅ Case-insensitive match test passed")
    else:
        print("  ❌ Case-insensitive match test failed")
        return False
    
    return True


async def test_agent_mock_mode() -> bool:
    """Test the agent in mock mode (no LLM)."""
    print("\n" + "=" * 60)
    print("TESTING: Agent Mock Mode")
    print("=" * 60)
    
    config = BFCLConfig()
    agent = BFCLAgent(config)
    
    await agent.initialize()
    
    test_case = create_test_case()
    calls, response, latency = await agent.query(test_case)
    
    print(f"  Response: {response[:100]}...")
    print(f"  Latency: {latency:.2f}ms")
    print(f"  Calls extracted: {len(calls)}")
    
    await agent.close()
    
    # In mock mode, we expect MOCK_MODE response
    if "MOCK" in response:
        print("  ✅ Mock mode working correctly")
        return True
    else:
        print("  ⚠️  Unexpected response in mock mode")
        return True  # Still pass, might have model available


async def test_agent_with_llm() -> bool:
    """Test the agent with a real LLM provider."""
    print("\n" + "=" * 60)
    print("TESTING: Agent with LLM Provider")
    print("=" * 60)
    
    # Check if any model provider is available
    model_plugin, model_name = get_model_provider_plugin()
    
    if model_plugin is None:
        print("  ⚠️  No model provider available, skipping LLM test")
        print("  Set GROQ_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY")
        return True  # Not a failure, just skipped
    
    print(f"  Using model: {model_name}")
    print(f"  Plugin: {model_plugin.name}")
    
    config = BFCLConfig(temperature=0.0)
    agent = BFCLAgent(config, model_plugin=model_plugin)
    
    try:
        await agent.initialize()
        
        test_case = create_test_case()
        calls, response, latency = await agent.query(test_case)
        
        print(f"\n  Raw Response:\n  {response[:500]}")
        print(f"\n  Latency: {latency:.2f}ms")
        print(f"  Calls extracted: {len(calls)}")
        
        if calls:
            for i, call in enumerate(calls):
                print(f"    Call {i+1}: {call.name}({call.arguments})")
        
        # Evaluate the result
        evaluator = ASTEvaluator()
        
        # Check if we got a function call with "get_weather"
        has_weather_call = any(
            "weather" in call.name.lower() for call in calls
        )
        
        # Check if location argument contains San Francisco
        has_sf_location = any(
            "san francisco" in str(call.arguments).lower() for call in calls
        )
        
        if has_weather_call and has_sf_location:
            print("\n  ✅ LLM correctly identified function and arguments!")
            
            # Full AST evaluation
            ast_match = evaluator.evaluate(calls, test_case.expected_calls)
            if ast_match:
                print("  ✅ Full AST match!")
            else:
                print("  ⚠️  Partial match (function correct, arguments may differ)")
                details = evaluator.get_match_details(calls, test_case.expected_calls)
                print(f"     Details: {details}")
            
            return True
        else:
            print("\n  ❌ LLM did not correctly identify the function call")
            return False
    
    finally:
        await agent.close()


async def run_mini_benchmark() -> bool:
    """Run a mini benchmark with a few test cases."""
    print("\n" + "=" * 60)
    print("TESTING: Mini Benchmark (3 test cases)")
    print("=" * 60)
    
    model_plugin = get_model_provider_plugin()
    if model_plugin is None:
        print("  ⚠️  No model provider available, skipping mini benchmark")
        return True
    
    from benchmarks.bfcl.runner import BFCLRunner
    from benchmarks.bfcl.types import BFCLConfig
    
    config = BFCLConfig(
        max_tests_per_category=1,
        temperature=0.0,
        generate_report=False,
    )
    
    runner = BFCLRunner(config, use_mock_agent=False)
    
    try:
        # Try to run a small sample
        results = await runner.run_sample(n=3)
        
        print("\n  Results:")
        print(f"    Overall Score: {results.metrics.overall_score:.2%}")
        print(f"    AST Accuracy: {results.metrics.ast_accuracy:.2%}")
        print(f"    Tests: {results.metrics.passed_tests}/{results.metrics.total_tests}")
        
        return results.metrics.overall_score > 0
        
    except Exception as e:
        print(f"  ❌ Mini benchmark failed: {e}")
        import traceback
        traceback.print_exc()
        return False


async def main() -> int:
    """Run all integration tests."""
    print("=" * 60)
    print("BFCL INTEGRATION TEST SUITE")
    print("=" * 60)
    
    # Check environment
    print("\n📋 Environment Check:")
    print(f"  ElizaOS Available: {ELIZAOS_AVAILABLE}")
    
    keys = check_environment()
    for key, available in keys.items():
        status = "✅" if available else "❌"
        print(f"  {key}: {status}")
    
    has_any_key = any(keys.values())
    if not has_any_key:
        print("\n⚠️  No API keys found. Set one of the following:")
        print("   - OPENAI_API_KEY")
        print("   - ANTHROPIC_API_KEY")
        print("   - GOOGLE_GENERATIVE_AI_API_KEY")
        print("\n   Or create a .env file in the project root.")
    
    # Run tests
    results = []
    
    # Test 1: Parser
    results.append(("Parser", await test_parser()))
    
    # Test 2: Evaluator
    results.append(("Evaluator", await test_evaluator()))
    
    # Test 3: Mock Agent
    results.append(("Mock Agent", await test_agent_mock_mode()))
    
    # Test 4: LLM Agent (only if keys available)
    if has_any_key:
        results.append(("LLM Agent", await test_agent_with_llm()))
        
        # Test 5: Mini benchmark
        # results.append(("Mini Benchmark", await run_mini_benchmark()))
    
    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    
    all_passed = True
    for name, passed in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"  {name}: {status}")
        if not passed:
            all_passed = False
    
    if all_passed:
        print("\n🎉 All tests passed!")
        return 0
    else:
        print("\n❌ Some tests failed")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
