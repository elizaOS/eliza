import random
import requests
import logging
import time
from typing import List, Dict, Optional
from dataclasses import dataclass
from threading import Lock
import json

logger = logging.getLogger("desktopenv.providers.aws.ProxyPool")
logger.setLevel(logging.INFO)

@dataclass
class ProxyInfo:
    host: str
    port: int
    username: Optional[str] = None
    password: Optional[str] = None
    protocol: str = "http"  # http, https, socks5
    failed_count: int = 0
    last_used: float = 0
    is_active: bool = True

class ProxyPool:
    def __init__(self, config_file: str = None):
        self.proxies: List[ProxyInfo] = []
        self.current_index = 0
        self.lock = Lock()
        self.max_failures = 3  # 最大失败次数
        self.cooldown_time = 300  # 5分钟冷却时间
        
        if config_file:
            self.load_proxies_from_file(config_file)
    
    def load_proxies_from_file(self, config_file: str):
        """Load proxy list from config file"""
        try:
            with open(config_file, 'r') as f:
                proxy_configs = json.load(f)
                
            for config in proxy_configs:
                proxy = ProxyInfo(
                    host=config['host'],
                    port=config['port'],
                    username=config.get('username'),
                    password=config.get('password'),
                    protocol=config.get('protocol', 'http')
                )
                self.proxies.append(proxy)
                
            logger.info(f"Loaded {len(self.proxies)} proxies from {config_file}")
        except Exception as e:
            logger.error(f"Failed to load proxies from {config_file}: {e}")
    
    def add_proxy(self, host: str, port: int, username: str = None, 
                  password: str = None, protocol: str = "http"):
        """Add proxy to pool"""
        proxy = ProxyInfo(host=host, port=port, username=username, 
                         password=password, protocol=protocol)
        with self.lock:
            self.proxies.append(proxy)
        logger.info(f"Added proxy {host}:{port}")
    
    def get_next_proxy(self) -> Optional[ProxyInfo]:
        """Get next available proxy"""
        with self.lock:
            if not self.proxies:
                return None
            
            # Filter out proxies with too many failures
            active_proxies = [p for p in self.proxies if self._is_proxy_available(p)]
            
            if not active_proxies:
                logger.warning("No active proxies available")
                return None
            
            # Round-robin selection of proxy
            proxy = active_proxies[self.current_index % len(active_proxies)]
            self.current_index += 1
            proxy.last_used = time.time()
            
            return proxy
    
    def _is_proxy_available(self, proxy: ProxyInfo) -> bool:
        """Check if proxy is available"""
        if not proxy.is_active:
            return False
        
        if proxy.failed_count >= self.max_failures:
            # Check if cooldown time has passed
            if time.time() - proxy.last_used < self.cooldown_time:
                return False
            else:
                # Reset failure count
                proxy.failed_count = 0
        
        return True
    
    def mark_proxy_failed(self, proxy: ProxyInfo):
        """Mark proxy as failed"""
        with self.lock:
            proxy.failed_count += 1
            if proxy.failed_count >= self.max_failures:
                logger.warning(f"Proxy {proxy.host}:{proxy.port} marked as failed "
                             f"(failures: {proxy.failed_count})")
    
    def mark_proxy_success(self, proxy: ProxyInfo):
        """Mark proxy as successful"""
        with self.lock:
            proxy.failed_count = 0
    
    def test_proxy(self, proxy: ProxyInfo, test_url: str = "http://httpbin.org/ip", 
                   timeout: int = 10) -> bool:
        """Test if proxy is working"""
        try:
            proxy_url = self._format_proxy_url(proxy)
            proxies = {
                'http': proxy_url,
                'https': proxy_url
            }
            
            response = requests.get(test_url, proxies=proxies, timeout=timeout)
            if response.status_code == 200:
                self.mark_proxy_success(proxy)
                return True
            else:
                self.mark_proxy_failed(proxy)
                return False
                
        except Exception as e:
            logger.debug(f"Proxy test failed for {proxy.host}:{proxy.port}: {e}")
            self.mark_proxy_failed(proxy)
            return False
    
    def _format_proxy_url(self, proxy: ProxyInfo) -> str:
        """Format proxy URL"""
        if proxy.username and proxy.password:
            return f"{proxy.protocol}://{proxy.username}:{proxy.password}@{proxy.host}:{proxy.port}"
        else:
            return f"{proxy.protocol}://{proxy.host}:{proxy.port}"
    
    def get_proxy_dict(self, proxy: ProxyInfo) -> Dict[str, str]:
        """Get proxy dictionary for requests library"""
        proxy_url = self._format_proxy_url(proxy)
        return {
            'http': proxy_url,
            'https': proxy_url
        }
    
    def test_all_proxies(self, test_url: str = "http://httpbin.org/ip"):
        """Test all proxies"""
        logger.info("Testing all proxies...")
        working_count = 0
        
        for proxy in self.proxies:
            if self.test_proxy(proxy, test_url):
                working_count += 1
                logger.info(f"✓ Proxy {proxy.host}:{proxy.port} is working")
            else:
                logger.warning(f"✗ Proxy {proxy.host}:{proxy.port} failed")
        
        logger.info(f"Proxy test completed: {working_count}/{len(self.proxies)} working")
        return working_count
    
    def get_stats(self) -> Dict:
        """Get proxy pool statistics"""
        with self.lock:
            total = len(self.proxies)
            active = len([p for p in self.proxies if self._is_proxy_available(p)])
            failed = len([p for p in self.proxies if p.failed_count >= self.max_failures])
            
            return {
                'total': total,
                'active': active,
                'failed': failed,
                'success_rate': active / total if total > 0 else 0
            }

# Global proxy pool instance
_proxy_pool = None

def get_global_proxy_pool() -> ProxyPool:
    """Get global proxy pool instance"""
    global _proxy_pool
    if _proxy_pool is None:
        _proxy_pool = ProxyPool()
    return _proxy_pool

def init_proxy_pool(config_file: str = None):
    """Initialize global proxy pool"""
    global _proxy_pool
    _proxy_pool = ProxyPool(config_file)
    return _proxy_pool 