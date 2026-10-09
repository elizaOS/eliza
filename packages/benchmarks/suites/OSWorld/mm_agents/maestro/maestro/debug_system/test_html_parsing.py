#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test script to verify HTML parsing logic for Steam cart evaluation
"""

import json
import sys
import os

# Add the osworld directory to Python path
sys.path.insert(0, '/home/lxguo/osworld')

from desktop_env.evaluators.metrics.chrome import is_added_to_steam_cart
from desktop_env.evaluators.getters.chrome import get_page_info

def test_html_parsing():
    """
    Test the HTML parsing logic for Steam cart evaluation using real HTML file
    """
    print("=== Testing HTML Parsing Logic with Real HTML ===")
    
    # Load the evaluation configuration
    config_path = '/home/lxguo/osworld/evaluation_examples/examples/chrome/121ba48f-9e17-48ce-9bc6-a4fb17a7ebba.json'
    
    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
        print(f"✓ Loaded configuration from {config_path}")
    except Exception as e:
        print(f"✗ Failed to load configuration: {e}")
        return
    
    # Extract evaluation parameters
    evaluator = config['evaluator']
    expected_items = evaluator['expected']['rules']['items']
    target_url = evaluator['result']['url']
    
    print(f"Target URL: {target_url}")
    print(f"Expected items: {expected_items}")
    
    # Load real HTML content from file
    real_html_path = '/home/lxguo/osworld/real_cart.html'
    try:
        with open(real_html_path, 'r', encoding='utf-8') as f:
            real_html_content = f.read()
        print(f"✓ Loaded real HTML from {real_html_path}")
        print(f"HTML content length: {len(real_html_content)} characters")
    except Exception as e:
        print(f"✗ Failed to load real HTML: {e}")
        return
    
    # Simulate active_tab_info structure with real HTML
    real_active_tab_info = {
        'title': 'Shopping Cart',
        'url': target_url,
        'content': real_html_content
    }
    
    # Test the evaluation function with real HTML
    rule = {'items': expected_items}
    
    print("\n=== Testing is_added_to_steam_cart function with Real HTML ===")
    print(f"Rule: {rule}")
    
    # Check if the expected item is in the real HTML content
    print("\n--- Searching for expected items in real HTML ---")
    for item in expected_items:
        if item in real_html_content:
            print(f"✓ Found '{item}' in real HTML content")
        else:
            print(f"✗ '{item}' NOT found in real HTML content")
            
            # Try case-insensitive search
            if item.lower() in real_html_content.lower():
                print(f"  ℹ Found '{item}' with case-insensitive search")
            else:
                print(f"  ℹ '{item}' not found even with case-insensitive search")
                
                # Try searching for individual words
                words = item.split()
                found_words = []
                for word in words:
                    if word.lower() in real_html_content.lower():
                        found_words.append(word)
                if found_words:
                    print(f"  ℹ Found individual words: {found_words}")
                else:
                    print(f"  ℹ No individual words from '{item}' found")
    
    # Call the actual evaluation function
    try:
        result = is_added_to_steam_cart(real_active_tab_info, rule)
        print(f"\nEvaluation result with real HTML: {result}")
        
        if result == 1.0:
            print("✓ Evaluation PASSED - All items found in real HTML")
        else:
            print("✗ Evaluation FAILED - Some items missing in real HTML")
            
    except Exception as e:
        print(f"✗ Error during evaluation: {e}")
        import traceback
        traceback.print_exc()
    
    # Additional analysis of the real HTML content
    print("\n=== Additional Analysis of Real HTML Content ===")
    
    # Check for common Steam cart indicators
    cart_indicators = [
        'cart', 'Cart', 'CART',
        'shopping', 'Shopping', 'SHOPPING',
        'dota', 'Dota', 'DOTA',
        'soundtrack', 'Soundtrack', 'SOUNDTRACK',
        'official', 'Official', 'OFFICIAL'
    ]
    
    print("\n--- Checking for cart-related keywords ---")
    for indicator in cart_indicators:
        count = real_html_content.count(indicator)
        if count > 0:
            print(f"✓ Found '{indicator}' {count} times")
        else:
            print(f"✗ '{indicator}' not found")
    
    # Look for any mention of "Dota" in various forms
    print("\n--- Searching for Dota-related content ---")
    dota_patterns = ['dota', 'Dota', 'DOTA', 'Dota 2', 'dota 2', 'DOTA 2']
    for pattern in dota_patterns:
        if pattern in real_html_content:
            # Find the context around the match
            index = real_html_content.find(pattern)
            start = max(0, index - 50)
            end = min(len(real_html_content), index + len(pattern) + 50)
            context = real_html_content[start:end].replace('\n', ' ').strip()
            print(f"✓ Found '{pattern}' at position {index}")
            print(f"  Context: ...{context}...")
            break
    else:
        print("✗ No Dota-related content found")
    
    # Check if this is actually an empty cart page
    empty_indicators = ['empty', 'Empty', 'EMPTY', 'no items', 'No items', 'NO ITEMS']
    print("\n--- Checking for empty cart indicators ---")
    for indicator in empty_indicators:
        if indicator in real_html_content:
            print(f"⚠ Found empty cart indicator: '{indicator}'")
    
    # Show some basic HTML structure info
    print(f"\n--- HTML Structure Info ---")
    print(f"Total HTML length: {len(real_html_content)} characters")
    print(f"Number of <div> tags: {real_html_content.count('<div')}")
    print(f"Number of <a> tags: {real_html_content.count('<a')}")
    print(f"Contains JavaScript: {'<script' in real_html_content}")
    
    print("\n=== Analysis Complete ===")
    print("\nKey points to check:")
    print("1. The evaluation function uses simple string matching")
    print("2. It checks if ALL items in the rule are present in the HTML content")
    print("3. The HTML content comes from page.content() which returns the full page HTML")
    print("4. If the expected text is not in the HTML, the evaluation will fail")
    print("\nPossible issues:")
    print("- Dynamic content loaded via JavaScript after page.content() is called")
    print("- Text might be in a different format (e.g., encoded, with extra spaces)")
    print("- Page might not be fully loaded when content is captured")
    print("- Network issues preventing proper page loading")

if __name__ == "__main__":
    test_html_parsing()