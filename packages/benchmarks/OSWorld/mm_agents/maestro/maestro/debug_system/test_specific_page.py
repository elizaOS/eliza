#!/usr/bin/env python3
"""
Test the specific FlightAware discussions page that failed in the evaluation
"""

import requests
import json
from urllib.parse import urlparse

def load_proxy_config():
    """Load proxy configuration from dataimpulse.json"""
    try:
        with open('/home/lxguo/osworld/evaluation_examples/settings/proxy/dataimpulse.json', 'r') as f:
            proxy_configs = json.load(f)
            # dataimpulse.json contains an array, get the first proxy
            if isinstance(proxy_configs, list) and len(proxy_configs) > 0:
                return proxy_configs[0]
            else:
                return proxy_configs
    except Exception as e:
        print(f"Error loading proxy config: {e}")
        return None

def get_proxy_dict(proxy_config):
    """Convert proxy config to requests proxy format"""
    if not proxy_config:
        return None
    
    proxy_url = f"http://{proxy_config['username']}:{proxy_config['password']}@{proxy_config['host']}:{proxy_config['port']}"
    return {
        'http': proxy_url,
        'https': proxy_url
    }

def test_specific_url(url, use_proxy=False, proxy_dict=None):
    """Test the specific URL that failed in evaluation"""
    print(f"\n=== Testing {url} ===\n")
    
    try:
        # Test with GET request to simulate browser behavior
        headers = {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        }
        
        response = requests.get(
            url, 
            headers=headers,
            proxies=proxy_dict if use_proxy else None,
            timeout=60,
            allow_redirects=True
        )
        
        print(f"Status Code: {response.status_code}")
        print(f"Final URL: {response.url}")
        print(f"Response Size: {len(response.content)} bytes")
        
        # Check response headers
        print("\nKey Response Headers:")
        for header in ['server', 'cf-ray', 'cf-cache-status', 'content-type']:
            if header in response.headers:
                print(f"  {header}: {response.headers[header]}")
        
        # Check if we got the actual page content
        if response.status_code == 200:
            content = response.text.lower()
            if 'banter' in content or 'thread' in content or 'discourse' in content:
                print("✅ Successfully loaded page content")
            elif 'cloudflare' in content or 'challenge' in content:
                print("⚠️  Got Cloudflare challenge page")
            elif len(content) < 1000:
                print(f"⚠️  Suspiciously small content: {len(content)} chars")
                print(f"Content preview: {content[:200]}...")
            else:
                print("✅ Got substantial content")
        
        return True, response.status_code, len(response.content)
        
    except requests.exceptions.ProxyError as e:
        print(f"❌ Proxy Error: {e}")
        return False, None, 0
    except requests.exceptions.Timeout as e:
        print(f"❌ Timeout Error: {e}")
        return False, None, 0
    except requests.exceptions.RequestException as e:
        print(f"❌ Request Error: {e}")
        return False, None, 0

def main():
    print("Testing Specific FlightAware Discussions Page")
    print("=" * 60)
    
    # Load proxy configuration
    proxy_config = load_proxy_config()
    if proxy_config:
        print(f"✅ Loaded proxy: {proxy_config['host']}:{proxy_config['port']}")
        proxy_dict = get_proxy_dict(proxy_config)
    else:
        print("❌ Failed to load proxy configuration")
        return
    
    # The specific URL that failed in the evaluation
    target_url = "https://discussions.flightaware.com/t/the-banter-thread/4412"
    
    print(f"\nTarget URL: {target_url}")
    print("This is the exact URL that failed in the evaluation log\n")
    
    # Test direct connection
    print("=" * 40)
    print("DIRECT CONNECTION TEST")
    print("=" * 40)
    direct_success, direct_status, direct_size = test_specific_url(target_url, use_proxy=False)
    
    # Test proxy connection
    print("\n" + "=" * 40)
    print("PROXY CONNECTION TEST")
    print("=" * 40)
    proxy_success, proxy_status, proxy_size = test_specific_url(target_url, use_proxy=True, proxy_dict=proxy_dict)
    
    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    
    print(f"\nDirect Connection:")
    print(f"  Success: {'✅' if direct_success else '❌'}")
    print(f"  Status:  {direct_status}")
    print(f"  Size:    {direct_size} bytes")
    
    print(f"\nProxy Connection:")
    print(f"  Success: {'✅' if proxy_success else '❌'}")
    print(f"  Status:  {proxy_status}")
    print(f"  Size:    {proxy_size} bytes")
    
    # Analysis
    print("\n" + "=" * 60)
    print("ANALYSIS")
    print("=" * 60)
    
    if direct_success and not proxy_success:
        print("\n🔍 Finding: Proxy connection fails while direct works")
        print("   This matches the evaluation log error pattern")
    elif not direct_success and not proxy_success:
        print("\n🔍 Finding: Both connections fail")
        print("   The page might be restricted or have issues")
    elif direct_success and proxy_success:
        print("\n🔍 Finding: Both connections work")
        print("   The issue might be intermittent or evaluation-specific")
    else:
        print("\n🔍 Finding: Unexpected pattern - proxy works but direct fails")
    
    # Additional tests with different approaches
    print("\n" + "=" * 60)
    print("ADDITIONAL TESTS")
    print("=" * 60)
    
    # Test the base discussions URL
    base_url = "https://discussions.flightaware.com"
    print(f"\nTesting base URL: {base_url}")
    
    print("\n--- Direct ---")
    base_direct_success, _, _ = test_specific_url(base_url, use_proxy=False)
    
    print("\n--- Proxy ---")
    base_proxy_success, _, _ = test_specific_url(base_url, use_proxy=True, proxy_dict=proxy_dict)
    
    if base_proxy_success and not proxy_success:
        print("\n💡 Insight: Base discussions URL works with proxy, but specific thread fails")
        print("   This suggests the issue is with specific deep-linked content")

if __name__ == "__main__":
    main()