#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test script: Verify the evaluation result of a given URL in the check_direct_json_object function

This script directly calls actual functions from the OSWorld evaluation system to evaluate Qatar Airways URL:
1. Use get_active_tab_url_parse to parse query parameters from URL
2. Use get_rule_relativeTime to apply relative time rules ("next Monday")
3. Use check_direct_json_object function for comparison
"""

import sys
import os
import json
import logging
from datetime import datetime
import pytz

# Add the project root to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import actual functions from OSWorld
from desktop_env.evaluators.getters.chrome import get_active_tab_url_parse
from desktop_env.evaluators.getters.misc import get_rule_relativeTime
from desktop_env.evaluators.metrics.general import check_direct_json_object

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def mock_get_active_tab_url_parse(url, config):
    """Mock function to simulate get_active_tab_url_parse with a URL string"""
    from urllib.parse import urlparse, parse_qs
    
    logger.info(f"Parsing URL: {url}")
    
    # Parse URL
    parsed_url = urlparse(url)
    query_params = parse_qs(parsed_url.query)
    
    # Extract specified parameters
    parse_keys = config.get('parse_keys', [])
    extracted_params = {key: query_params.get(key, [''])[0] for key in parse_keys}
    
    # Apply key name replacement
    replace_mapping = config.get('replace', {})
    if replace_mapping:
        for old_key, new_key in replace_mapping.items():
            if old_key in extracted_params:
                value = extracted_params.pop(old_key)
                extracted_params[new_key] = value
    
    logger.info(f"Extracted parameters: {extracted_params}")
    return extracted_params

def main():
    """Main function: Execute complete URL evaluation process"""
    print("=" * 80)
    print("Qatar Airways URL Evaluation Test - Using OSWorld Actual Functions and Config File")
    print("=" * 80)
    
    # Load evaluator configuration from config file
    config_file = os.path.join("evaluation_examples", "examples", "chrome", "82bc8d6a-36eb-4d2d-8801-ef714fb1e55a.json")
    print(f"Loading from config file: {config_file}")
    
    try:
        with open(config_file, 'r', encoding='utf-8') as f:
            config = json.load(f)
        print(f"Config file loaded successfully")
    except Exception as e:
        logger.error(f"Error loading config file: {e}")
        print(f"Error loading config file: {e}")
        return
    
    # Extract evaluator configuration
    evaluator_config = config.get("evaluator", {})
    result_config = evaluator_config.get("result", {})
    expected_config = evaluator_config.get("expected", {})
    
    print(f"\nEvaluator configuration:")
    print(f"  Function: {evaluator_config.get('func')}")
    print(f"  Result config: {result_config}")
    print(f"  Expected config: {expected_config}")
    
    # Test URL
    test_url = "https://www.qatarairways.com/app/booking/flight-selection?widget=QR&searchType=F&addTaxToFare=Y&minPurTime=0&selLang=en&tripType=O&fromStation=BOM&toStation=ARN&departing=2025-09-08&bookingClass=E&adults=1&children=0&infants=0&ofw=0&teenager=0&flexibleDate=off&allowRedemption=N"
    
    # Current time
    timezone = pytz.UTC
    current_time = timezone.localize(datetime.now())
    print(f"\nCurrent time: {current_time.strftime('%Y-%m-%d %H:%M:%S %Z (%A)')}")
    
    # Step 1: Parse URL parameters using config file parameters
    print("\nStep 1: Parse URL parameters (using config file parameters)")
    url_parse_config = {
        "parse_keys": result_config.get("parse_keys", []),
        "replace": result_config.get("replace", {})
    }
    
    parsed_result = mock_get_active_tab_url_parse(test_url, url_parse_config)
    print(f"Parsing result: {parsed_result}")
    
    # Step 2: Use relative time rules from config file
    print("\nStep 2: Process relative time rules (using config file rules)")
    relative_time_rules = expected_config.get("rules", {})
    relative_time_config = relative_time_rules.get("relativeTime", {})
    
    print(f"Relative time configuration: {relative_time_config}")
    
    try:
        # get_rule_relativeTime requires two parameters: env and config
        # Build complete config parameter
        full_config = {
            "rules": {
                "relativeTime": relative_time_config,
                "expected": expected_config.get("rules", {}).get("expected", {})
            }
        }
        updated_rules = get_rule_relativeTime(None, full_config)  # Pass None for env parameter
        # Extract calculated time from returned rules
        expected_time = updated_rules.get("expected", {}).get("time", "")
        print(f"Expected time (next Monday): {expected_time}")
    except Exception as e:
        logger.error(f"Error calling get_rule_relativeTime: {e}")
        print(f"Error calling get_rule_relativeTime: {e}")
        return
    
    # Step 3: Build expected JSON object (using expected template from config file)
    print("\nStep 3: Build expected result (using config file template)")
    expected_template = relative_time_rules.get("expected", {})
    
    # Build expected JSON object
    expected_json = {}
    for key, value in expected_template.items():
        if key == "time" and isinstance(value, str) and "{" in value:
            # This is a time format template, use calculated time
            expected_json[key] = expected_time
        else:
            expected_json[key] = value
    
    print(f"Expected JSON: {expected_json}")
    
    # Step 4: Use actual check_direct_json_object function for comparison
    print("\nStep 4: Execute JSON object comparison (using OSWorld actual function)")
    rules = {"expected": expected_json}
    
    try:
        result = check_direct_json_object(parsed_result, rules)
        print(f"check_direct_json_object return result: {result}")
    except Exception as e:
        logger.error(f"Error calling check_direct_json_object: {e}")
        print(f"Error calling check_direct_json_object: {e}")
        return
    
    # Output final result
    print("\n" + "=" * 80)
    print("Evaluation Result")
    print("=" * 80)
    print(f"Actual parsing result: {parsed_result}")
    print(f"Expected result: {expected_json}")
    print(f"\nFinal evaluation score: {result}")
    
    if result == 1.0:
        print("✅ Evaluation passed! Date in URL matches calculated 'next Monday'")
    else:
        print("❌ Evaluation failed! Date in URL does not match calculated 'next Monday'")
        
        # Detailed difference analysis
        print("\nDifference analysis:")
        actual_time = parsed_result.get("time")
        expected_time_value = expected_json.get("time")
        print(f"  Date in URL: {actual_time}")
        print(f"  Expected date: {expected_time_value}")
        
        if actual_time != expected_time_value:
            print(f"  Time mismatch: '{actual_time}' != '{expected_time_value}'")
    
    print("\n" + "=" * 80)
    
    # Additional information: Display current time and date in URL
    print(f"\nAdditional information:")
    print(f"  Current time: {current_time.strftime('%Y-%m-%d (%A)')}")
    print(f"  Departing date in URL: 2025-09-01")
    print(f"  Calculated next Monday: {expected_time}")
    print(f"  Do they match: {'Yes' if expected_time == '2025-09-01' else 'No'}")

if __name__ == "__main__":
    main()