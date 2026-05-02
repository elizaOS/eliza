#!/usr/bin/env python3
# Test script to verify Dataimpulse proxy connectivity

import requests
import json
import time
from urllib.parse import urlparse

def load_proxy_config():
    """Load proxy configuration from the JSON file"""
    try:
        with open('/home/lxguo/osworld/evaluation_examples/settings/proxy/dataimpulse.json', 'r') as f:
            proxy_configs = json.load(f)
        # Return the first proxy configuration if it's a list
        if isinstance(proxy_configs, list) and len(proxy_configs) > 0:
            return proxy_configs[0]
        elif isinstance(proxy_configs, dict):
            return proxy_configs
        else:
            print("Invalid proxy configuration format")
            return None
    except Exception as e:
        print(f"Error loading proxy config: {e}")
        return None

def format_proxy_url(proxy_config):
    """Format proxy URL with authentication"""
    if proxy_config['username'] and proxy_config['password']:
        return f"http://{proxy_config['username']}:{proxy_config['password']}@{proxy_config['host']}:{proxy_config['port']}"
    else:
        return f"http://{proxy_config['host']}:{proxy_config['port']}"

def test_proxy_connectivity(proxy_url, test_urls=None):
    """Test proxy connectivity with multiple URLs"""
    if test_urls is None:
        test_urls = [
            'http://httpbin.org/ip',
            'https://httpbin.org/ip', 
            'https://www.google.com',
            'https://www.flightaware.com',
            'https://www.discussions.flightaware.com'
        ]
    
    proxies = {
        'http': proxy_url,
        'https': proxy_url
    }
    
    results = []
    
    for url in test_urls:
        print(f"\nTesting {url}...")
        try:
            start_time = time.time()
            response = requests.get(url, proxies=proxies, timeout=30)
            end_time = time.time()
            
            result = {
                'url': url,
                'status_code': response.status_code,
                'response_time': round(end_time - start_time, 2),
                'success': True,
                'error': None
            }
            
            if 'httpbin.org/ip' in url:
                try:
                    ip_info = response.json()
                    result['origin_ip'] = ip_info.get('origin', 'Unknown')
                    print(f"  ✓ Success! Status: {response.status_code}, Time: {result['response_time']}s, IP: {result['origin_ip']}")
                except:
                    print(f"  ✓ Success! Status: {response.status_code}, Time: {result['response_time']}s")
            else:
                print(f"  ✓ Success! Status: {response.status_code}, Time: {result['response_time']}s")
                
        except requests.exceptions.ProxyError as e:
            result = {
                'url': url,
                'status_code': None,
                'response_time': None,
                'success': False,
                'error': f"Proxy Error: {str(e)}"
            }
            print(f"  ✗ Proxy Error: {e}")
            
        except requests.exceptions.Timeout as e:
            result = {
                'url': url,
                'status_code': None,
                'response_time': None,
                'success': False,
                'error': f"Timeout: {str(e)}"
            }
            print(f"  ✗ Timeout: {e}")
            
        except Exception as e:
            result = {
                'url': url,
                'status_code': None,
                'response_time': None,
                'success': False,
                'error': f"Error: {str(e)}"
            }
            print(f"  ✗ Error: {e}")
            
        results.append(result)
    
    return results

def test_direct_connection(test_urls=None):
    """Test direct connection without proxy for comparison"""
    if test_urls is None:
        test_urls = [
            'http://httpbin.org/ip',
            'https://httpbin.org/ip'
        ]
    
    print("\n=== Testing Direct Connection (No Proxy) ===")
    results = []
    
    for url in test_urls:
        print(f"\nTesting {url} (direct)...")
        try:
            start_time = time.time()
            response = requests.get(url, timeout=10)
            end_time = time.time()
            
            result = {
                'url': url,
                'status_code': response.status_code,
                'response_time': round(end_time - start_time, 2),
                'success': True,
                'error': None
            }
            
            if 'httpbin.org/ip' in url:
                try:
                    ip_info = response.json()
                    result['origin_ip'] = ip_info.get('origin', 'Unknown')
                    print(f"  ✓ Success! Status: {response.status_code}, Time: {result['response_time']}s, IP: {result['origin_ip']}")
                except:
                    print(f"  ✓ Success! Status: {response.status_code}, Time: {result['response_time']}s")
            else:
                print(f"  ✓ Success! Status: {response.status_code}, Time: {result['response_time']}s")
                
        except Exception as e:
            result = {
                'url': url,
                'status_code': None,
                'response_time': None,
                'success': False,
                'error': f"Error: {str(e)}"
            }
            print(f"  ✗ Error: {e}")
            
        results.append(result)
    
    return results

def main():
    print("=== Dataimpulse Proxy Connectivity Test ===")
    
    # Load proxy configuration
    proxy_config = load_proxy_config()
    if not proxy_config:
        print("Failed to load proxy configuration")
        return
    
    print(f"\nProxy Configuration:")
    print(f"  Host: {proxy_config['host']}")
    print(f"  Port: {proxy_config['port']}")
    print(f"  Username: {proxy_config['username']}")
    print(f"  Provider: {proxy_config.get('provider', 'Unknown')}")
    print(f"  Type: {proxy_config.get('type', 'Unknown')}")
    print(f"  Country: {proxy_config.get('country', 'Unknown')}")
    
    # Format proxy URL
    proxy_url = format_proxy_url(proxy_config)
    print(f"\nFormatted Proxy URL: {proxy_url}")
    
    # Test direct connection first
    direct_results = test_direct_connection()
    
    # Test proxy connectivity
    print("\n=== Testing Proxy Connection ===")
    proxy_results = test_proxy_connectivity(proxy_url)
    
    # Summary
    print("\n=== SUMMARY ===")
    
    print("\nDirect Connection Results:")
    for result in direct_results:
        status = "✓" if result['success'] else "✗"
        print(f"  {status} {result['url']}: {result.get('error', 'Success')}")
    
    print("\nProxy Connection Results:")
    successful = 0
    total = len(proxy_results)
    
    for result in proxy_results:
        status = "✓" if result['success'] else "✗"
        if result['success']:
            successful += 1
            print(f"  {status} {result['url']}: Success ({result['response_time']}s)")
        else:
            print(f"  {status} {result['url']}: {result['error']}")
    
    print(f"\nProxy Success Rate: {successful}/{total} ({successful/total*100:.1f}%)")
    
    if successful == 0:
        print("\n⚠️  WARNING: Proxy is not working at all!")
        print("   Possible issues:")
        print("   1. Incorrect credentials")
        print("   2. Proxy server is down")
        print("   3. IP whitelist restrictions")
        print("   4. Network connectivity issues")
    elif successful < total:
        print(f"\n⚠️  WARNING: Proxy partially working ({successful}/{total} sites accessible)")
        print("   Some sites may be blocked or have connectivity issues")
    else:
        print("\n✅ Proxy is working correctly for all tested sites!")

if __name__ == "__main__":
    main()