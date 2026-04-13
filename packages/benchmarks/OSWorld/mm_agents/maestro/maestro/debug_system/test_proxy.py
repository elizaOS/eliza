import requests
import sys

def test_proxy():
    proxy_url = 'http://f5db4148984daf4755d9:f2dbf4fa10b20149@gw.dataimpulse.com:823'
    proxies = {
        'http': proxy_url,
        'https': proxy_url
    }
    
    try:
        print(f"Testing proxy: {proxy_url}")
        response = requests.get('http://httpbin.org/ip', proxies=proxies, timeout=10)
        print(f"Proxy test successful: {response.status_code}")
        print(f"Response: {response.text}")
        return True
    except Exception as e:
        print(f"Proxy test failed: {str(e)}")
        return False

if __name__ == "__main__":
    success = test_proxy()
    sys.exit(0 if success else 1)