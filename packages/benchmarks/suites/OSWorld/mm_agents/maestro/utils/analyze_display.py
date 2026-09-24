#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Display.json analyzer - Extract and analyze execution statistics from display.json files
"""

import json
import os
import glob
import re
from typing import Dict, List, Tuple


def extract_cost_value(cost_str: str) -> tuple:
    """
    Extract numeric value and currency symbol from cost string (e.g., "0.000343￥" -> (0.000343, "￥"))
    
    Args:
        cost_str: Cost string with currency symbol
        
    Returns:
        Tuple of (float value, currency symbol)
    """
    # Extract numeric value and currency symbol
    match = re.search(r'([\d.]+)([￥$€£¥]*)', cost_str)
    if match:
        value = float(match.group(1))
        currency = match.group(2) if match.group(2) else "￥"  # Default to ￥ if no symbol found
        return value, currency
    return 0.0, "￥"


def convert_currency_to_yuan(value: float, currency: str) -> float:
    """
    Convert different currencies to yuan (￥) for consistent cost calculation
    
    Args:
        value: Cost value
        currency: Currency symbol
        
    Returns:
        Value converted to yuan
    """
    # Simple conversion rates (you might want to use real-time rates in production)
    conversion_rates = {
        "￥": 1.0,
        "¥": 1.0,
        "$": 7.2,  # USD to CNY (approximate)
        "€": 7.8,  # EUR to CNY (approximate)
        "£": 9.1,  # GBP to CNY (approximate)
    }

    rate = conversion_rates.get(currency, 1.0)
    return value * rate


def analyze_display_json(file_path: str) -> Dict:
    """
    Analyze a single display.json file and extract statistics
    
    Args:
        file_path: Path to the display.json file
        
    Returns:
        Dictionary containing analysis results
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
        return {}

    # Initialize counters
    action_count = 0
    total_duration = 0
    total_input_tokens = 0
    total_output_tokens = 0
    total_tokens = 0
    total_cost = 0.0
    currency_symbol = "￥"  # Default currency symbol

    # Check if this is agents3 format (has controller.main_loop_completed)
    is_agents3 = False
    if 'operations' in data and 'controller' in data['operations']:
        for operation in data['operations']['controller']:
            if operation.get('operation') == 'main_loop_completed':
                is_agents3 = True
                # Extract agents3 statistics
                action_count = operation.get('step_count', 0)
                total_duration = int(operation.get('duration', 0))
                break

    if is_agents3:
        # Agents3 mode analysis - extract from controller.main_loop_completed
        if 'operations' in data and 'controller' in data['operations']:
            for operation in data['operations']['controller']:
                if operation.get('operation') == 'main_loop_completed':
                    action_count = operation.get('step_count', 0)
                    total_duration = int(operation.get('duration', 0))
                    break

        # Extract tokens and cost from all operations
        if 'operations' in data:
            for module_name, module_operations in data['operations'].items():
                if isinstance(module_operations, list):
                    for operation in module_operations:
                        # Extract tokens if available
                        tokens = operation.get('tokens', [0, 0, 0])
                        if isinstance(tokens, list) and len(tokens) >= 3:
                            total_input_tokens += tokens[0]
                            total_output_tokens += tokens[1]
                            total_tokens += tokens[2]

                        # Extract cost if available
                        cost_str = operation.get('cost', '0￥')
                        cost_value, currency = extract_cost_value(cost_str)
                        # Convert to yuan for consistent calculation
                        cost_in_yuan = convert_currency_to_yuan(
                            cost_value, currency)
                        total_cost += cost_in_yuan
                        # Always use ￥ for consistency
                        currency_symbol = "￥"

    # Check if this is a fast mode or normal mode display.json
    elif 'operations' in data and 'agent' in data['operations']:
        # Fast mode analysis - similar to original logic
        if 'operations' in data and 'agent' in data['operations']:
            ops_list = [operation for operation in data['operations']['agent']]
            ops_list.extend([operation for operation in data['operations']['grounding']])
            for operation in ops_list:
                if operation.get('operation') == 'fast_planning_execution':
                    action_count += 1

                # Extract tokens
                tokens = operation.get('tokens', [0, 0, 0])
                if len(tokens) >= 3:
                    total_input_tokens += tokens[0]
                    total_output_tokens += tokens[1]
                    total_tokens += tokens[2]

                # Extract cost
                cost_str = operation.get('cost', '0￥')
                cost_value, currency = extract_cost_value(cost_str)
                # Convert to yuan for consistent calculation
                cost_in_yuan = convert_currency_to_yuan(cost_value, currency)
                total_cost += cost_in_yuan
                currency_symbol = "￥"  # Always use ￥ for consistency

        # Extract total execution time for fast mode
        if 'operations' in data and 'other' in data['operations']:
            for operation in data['operations']['other']:
                if operation.get('operation') == 'total_execution_time_fast':
                    total_duration = int(operation.get('duration', 0))
                    break
    else:
        # Normal mode analysis - analyze specific operations
        if 'operations' in data:
            # Define the operations to count for tokens and cost
            token_cost_operations = {
                'formulate_query', 'retrieve_narrative_experience', 'retrieve_knowledge',
                'knowledge_fusion', 'subtask_planner', 'generated_dag', 'reflection',
                'episode_summarization', 'narrative_summarization', 'Worker.retrieve_episodic_experience',
                'action_plan', 'grounding_model_response'
            }

            # Count hardware operations as steps
            if 'hardware' in data['operations']:
                action_count = len(data['operations']['hardware'])

            # Extract tokens and cost from specific operations across all modules
            for module_name, module_operations in data['operations'].items():
                if isinstance(module_operations, list):
                    for operation in module_operations:
                        operation_type = operation.get('operation', '')

                        # Only count tokens and cost for specified operations
                        if operation_type in token_cost_operations:
                            # Extract tokens if available
                            tokens = operation.get('tokens', [0, 0, 0])
                            if isinstance(tokens, list) and len(tokens) >= 3:
                                total_input_tokens += tokens[0]
                                total_output_tokens += tokens[1]
                                total_tokens += tokens[2]

                            # Extract cost if available
                            cost_str = operation.get('cost', '0￥')
                            cost_value, currency = extract_cost_value(cost_str)
                            # Convert to yuan for consistent calculation
                            cost_in_yuan = convert_currency_to_yuan(cost_value, currency)
                            total_cost += cost_in_yuan
                            # Always use ￥ for consistency
                            currency_symbol = "￥"

            # Extract total execution time for normal mode
            if 'other' in data['operations']:
                for operation in data['operations']['other']:
                    if operation.get('operation') == 'total_execution_time':
                        total_duration = int(operation.get('duration', 0))
                        break

    return {
        'action_count': action_count,
        'total_duration': total_duration,
        'total_input_tokens': total_input_tokens,
        'total_output_tokens': total_output_tokens,
        'total_tokens': total_tokens,
        'total_cost': total_cost,
        'currency_symbol': currency_symbol
    }


def analyze_folder(folder_path: str) -> List[Dict]:
    """
    Analyze all display.json files in a folder
    
    Args:
        folder_path: Path to the folder containing display.json files
        
    Returns:
        List of analysis results for each file
    """
    results = []

    # Find all display.json files recursively
    pattern = os.path.join(folder_path, "**", "display.json")
    display_files = glob.glob(pattern, recursive=True)

    if not display_files:
        print(f"No display.json files found in {folder_path}")
        return results

    print(f"Found {len(display_files)} display.json files")

    for file_path in display_files:
        print(f"Analyzing: {file_path}")
        result = analyze_display_json(file_path)
        if result:
            result['file_path'] = file_path
            results.append(result)

    return results


def aggregate_results(results: List[Dict]) -> Dict:
    """
    Aggregate results from multiple files
    
    Args:
        results: List of analysis results
        
    Returns:
        Aggregated statistics
    """
    if not results:
        return {}

    total_fast_actions = sum(r['action_count'] for r in results)
    total_duration = max(r['total_duration'] for r in results) if results else 0
    total_input_tokens = sum(r['total_input_tokens'] for r in results)
    total_output_tokens = sum(r['total_output_tokens'] for r in results)
    total_tokens = sum(r['total_tokens'] for r in results)
    total_cost = sum(r['total_cost'] for r in results)

    # Use the currency symbol from the first result, or default to ￥
    currency_symbol = results[0].get('currency_symbol', '￥') if results else '￥'

    return {
        'total_fast_actions': total_fast_actions,
        'total_duration': total_duration,
        'total_input_tokens': total_input_tokens,
        'total_output_tokens': total_output_tokens,
        'total_tokens': total_tokens,
        'total_cost': total_cost,
        'currency_symbol': currency_symbol
    }


def format_output_line(stats: Dict) -> str:
    """
    Format statistics into a single output line
    
    Args:
        stats: Statistics dictionary
        
    Returns:
        Formatted output line
    """
    if not stats:
        return "No data available"

    # Format: steps, duration (seconds), tokens, cost
    steps = stats.get('action_count', 0)
    duration = stats.get('total_duration', 0)
    tokens = (stats.get('total_input_tokens', 0),stats.get('total_output_tokens', 0),stats.get('total_tokens', 0))
    cost = stats.get('total_cost', 0.0)

    return f"{steps}, {duration}, {tokens}, {cost:.4f}{stats.get('currency_symbol', '￥')}"


def main():
    """
    Main function to analyze display.json files
    """
    import sys

    if len(sys.argv) < 2:
        print("Usage: python analyze_display.py <folder_path>")
        print("Example: python analyze_display.py lybicguiagents/runtime")
        return

    folder_path = sys.argv[1]

    if not os.path.exists(folder_path):
        print(f"Folder not found: {folder_path}")
        return

    # Analyze all display.json files in the folder
    results = analyze_folder(folder_path)

    if not results:
        print("No valid display.json files found")
        return

    # Aggregate results
    aggregated_stats = aggregate_results(results)

    # Print the required single line output
    print("\nStatistics:")
    print("-" * 80)
    print("Steps, Duration (seconds), (Input Tokens, Output Tokens, Total Tokens), Cost")
    print("-" * 80)
    output_line = format_output_line(aggregated_stats)
    print(output_line)
    print("-" * 80)


if __name__ == "__main__":
    main()
