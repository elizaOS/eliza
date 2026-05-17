"""
Client for the East Money (eastmoney.com) announcements API.

East Money provides a publicly accessible API for stock announcements
that serves as a reliable backup/secondary source alongside cninfo.
"""

import time
import logging
import requests
from datetime import datetime
from typing import List, Optional

logger = logging.getLogger(__name__)


class EastmoneyClient:
    """Fetch announcements from East Money stock API."""

    def __init__(self, base_url: str, timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
        })

    def _build_stock_filter(self, codes: List[str]) -> str:
        """Convert stock codes to eastmoney security filter format."""
        filters = []
        for code in codes:
            if code.startswith("6"):
                filters.append(f"SH{code}")
            elif code.startswith("0") or code.startswith("3"):
                filters.append(f"SZ{code}")
            else:
                filters.append(code)
        return ",".join(filters)

    def fetch_announcements(
        self,
        start_time: datetime,
        end_time: datetime,
        stock_codes: Optional[List[str]] = None,
        page_size: int = 50,
    ) -> list:
        """
        Fetch announcements from East Money.

        Returns list of dicts with keys:
            stock_code, stock_name, title, publish_time, url, category, source
        """
        results = []
        begin_date = start_time.strftime("%Y-%m-%d")
        end_date = end_time.strftime("%Y-%m-%d")

        stock_filter = ""
        if stock_codes:
            stock_filter = self._build_stock_filter(stock_codes)

        page = 1
        max_pages = 5

        while page <= max_pages:
            params = {
                "sr": -1,
                "page_size": page_size,
                "page_index": page,
                "ann_type": "SHA,SZA",
                "client_source": "web",
                "f_node": "0",
                "s_node": "0",
                "begin_time": begin_date,
                "end_time": end_date,
            }
            if stock_filter:
                params["stock_list"] = stock_filter

            try:
                resp = self.session.get(
                    f"{self.base_url}/security/ann",
                    params=params,
                    timeout=self.timeout,
                )
                resp.raise_for_status()
                data = resp.json()
            except requests.RequestException as e:
                logger.error("eastmoney request failed (page %d): %s", page, e)
                break
            except ValueError:
                logger.error("eastmoney returned non-JSON response")
                break

            if not data.get("success"):
                logger.warning("eastmoney API returned success=false")
                break

            items = data.get("data", {}).get("list", [])
            if not items:
                break

            for item in items:
                pub_str = item.get("notice_date", "")
                try:
                    pub_dt = datetime.strptime(pub_str, "%Y-%m-%d %H:%M:%S")
                except (ValueError, TypeError):
                    pub_dt = end_time

                if pub_dt < start_time or pub_dt > end_time:
                    continue

                codes = item.get("codes", [])
                for code_info in (codes or [{"stock_code": "", "short_name": ""}]):
                    results.append({
                        "stock_code": code_info.get("stock_code", ""),
                        "stock_name": code_info.get("short_name", ""),
                        "title": item.get("title", ""),
                        "publish_time": pub_dt.strftime("%Y-%m-%d %H:%M:%S"),
                        "url": f"https://data.eastmoney.com/notices/detail/{code_info.get('stock_code', '')}/{item.get('art_code', '')}.html",
                        "category": item.get("columns", [{}])[0].get("column_name", "other") if item.get("columns") else "other",
                        "source": "eastmoney",
                    })

            total = data.get("data", {}).get("total_hits", 0)
            if page * page_size >= total:
                break

            page += 1
            time.sleep(0.3)

        return results
