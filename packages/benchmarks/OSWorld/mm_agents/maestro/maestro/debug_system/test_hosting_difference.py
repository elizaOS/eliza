#!/usr/bin/env python3
"""
Test script to verify the hosting difference between FlightAware main site and discussions
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

def test_site_hosting(url, use_proxy=False, proxy_dict=None):
    """Test a site and analyze its hosting infrastructure"""
    print(f"\n=== Testing {url} ===\n")
    
    try:
        # Test with HEAD request to get headers without downloading content
        response = requests.head(
            url, 
            proxies=proxy_dict if use_proxy else None,
            timeout=30,
            allow_redirects=True
        )
        
        print(f"Status Code: {response.status_code}")
        print(f"Final URL: {response.url}")
        
        # Analyze hosting infrastructure
        headers = response.headers
        
        # Check for Cloudflare
        cloudflare_indicators = [
            'server' in headers and 'cloudflare' in headers['server'].lower(),
            any('cf-' in key.lower() for key in headers.keys()),
            any('__cf' in cookie for cookie in headers.get('set-cookie', '').split(';'))
        ]
        
        if any(cloudflare_indicators):
            print("🔵 Hosting: Cloudflare detected")
            if 'server' in headers:
                print(f"   Server: {headers['server']}")
        else:
            print("🟡 Hosting: Non-Cloudflare")
            if 'server' in headers:
                print(f"   Server: {headers['server']}")
        
        # Check for Discourse
        discourse_indicators = [
            'cdck-proxy-id' in headers,
            'discourse' in headers.get('server', '').lower(),
            'hosted-by-discourse' in response.url
        ]
        
        if any(discourse_indicators):
            print("💬 Platform: Discourse forum detected")
            if 'cdck-proxy-id' in headers:
                print(f"   Discourse Proxy: {headers['cdck-proxy-id']}")
        
        # Check for bot protection indicators
        protection_indicators = [
            'cf-ray' in headers,
            'cf-cache-status' in headers,
            any('challenge' in key.lower() for key in headers.keys())
        ]
        
        if any(protection_indicators):
            print("🛡️  Bot Protection: Likely present")
        
        return True, response.status_code
        
    except requests.exceptions.ProxyError as e:
        print(f"❌ Proxy Error: {e}")
        return False, None
    except requests.exceptions.RequestException as e:
        print(f"❌ Request Error: {e}")
        return False, None

def main():
    print("FlightAware Hosting Infrastructure Analysis")
    print("=" * 50)
    
    # Load proxy configuration
    proxy_config = load_proxy_config()
    if proxy_config:
        print(f"✅ Loaded proxy: {proxy_config['host']}:{proxy_config['port']}")
        proxy_dict = get_proxy_dict(proxy_config)
    else:
        print("❌ Failed to load proxy configuration")
        return
    
    # Test URLs
    test_urls = [
        "https://www.flightaware.com",
        "https://discussions.flightaware.com",
        "https://flightaware.hosted-by-discourse.com"
    ]
    
    results = {}
    
    for url in test_urls:
        print(f"\n{'='*60}")
        print(f"Testing: {url}")
        print(f"{'='*60}")
        
        # Test direct connection
        print("\n--- Direct Connection ---")
        direct_success, direct_status = test_site_hosting(url, use_proxy=False)
        
        # Test proxy connection
        print("\n--- Proxy Connection ---")
        proxy_success, proxy_status = test_site_hosting(url, use_proxy=True, proxy_dict=proxy_dict)
        
        results[url] = {
            'direct': {'success': direct_success, 'status': direct_status},
            'proxy': {'success': proxy_success, 'status': proxy_status}
        }
    
    # Summary
    print(f"\n\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    
    for url, result in results.items():
        print(f"\n{url}:")
        print(f"  Direct:  {'✅' if result['direct']['success'] else '❌'} (Status: {result['direct']['status']})")
        print(f"  Proxy:   {'✅' if result['proxy']['success'] else '❌'} (Status: {result['proxy']['status']})")
    
    # Analysis
    print(f"\n\n{'='*60}")
    print("ANALYSIS")
    print(f"{'='*60}")
    
    main_site_proxy_works = results["https://www.flightaware.com"]['proxy']['success']
    discussions_proxy_works = results["https://discussions.flightaware.com"]['proxy']['success']
    
    if main_site_proxy_works and not discussions_proxy_works:
        print("\n🔍 Key Finding:")
        print("   - Main site (Cloudflare-protected) works with proxy")
        print("   - Discussions (Discourse-hosted) fails with proxy")
        print("   - This suggests Discourse hosting has stricter proxy detection")
        print("   - Different hosting infrastructure = different proxy policies")
    elif not main_site_proxy_works and not discussions_proxy_works:
        print("\n🔍 Key Finding:")
        print("   - Both sites fail with proxy")
        print("   - This suggests general proxy blocking")
    else:
        print("\n🔍 Key Finding:")
        print("   - Proxy behavior is consistent across both sites")

if __name__ == "__main__":
    main()