"""
Client for the cninfo.com.cn disclosure API.

cninfo (China National Information Technology Inc.) is the official
disclosure platform for SZSE-listed companies. SSE companies also
publish via cninfo in many cases.

API reverse-engineered from the cninfo web disclosure search page.
"""

import time
import logging
import requests
from datetime import datetime
from typing import List, Optional

logger = logging.getLogger(__name__)


class CninfoClient:
    """Fetch announcements from cninfo disclosure API."""

    def __init__(self, base_url: str, timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
            "Referer": "http://www.cninfo.com.cn/new/disclosure",
            "Origin": "http://www.cninfo.com.cn",
        })

    def _map_category(self, cat: str) -> str:
        """Map internal category names to cninfo column codes."""
        mapping = {
            "annual_report": "category_ndbg_szsh",
            "quarterly_report": "category_sjdbg_szsh",
            "interim_report": "category_bndbg_szsh",
            "profit_forecast": "category_yjyg_szsh",
            "dividend": "category_fhps_szsh",
            "share_change": "category_gqbd_szsh",
            "board_resolution": "category_dshgg_szsh",
            "related_transaction": "category_glrjy_szsh",
            "equity_incentive": "category_gqjl_szsh",
            "major_event": "category_zdsx_szsh",
        }
        return mapping.get(cat, "")

    def fetch_announcements(
        self,
        start_time: datetime,
        end_time: datetime,
        stock_codes: Optional[List[str]] = None,
        categories: Optional[List[str]] = None,
        page_size: int = 30,
    ) -> list:
        """
        Fetch announcements within the given time window.

        Returns list of dicts with keys:
            stock_code, stock_name, title, publish_time, url, category, source
        """
        results = []
        se_date = start_time.strftime("%Y-%m-%d")
        ee_date = end_time.strftime("%Y-%m-%d")

        # Build column filter
        column = ""
        if categories:
            col_codes = [self._map_category(c) for c in categories if self._map_category(c)]
            column = ";".join(col_codes)

        # Build stock filter
        stock_str = ""
        if stock_codes:
            stock_str = ",".join(stock_codes)

        page_num = 1
        max_pages = 10

        while page_num <= max_pages:
            payload = {
                "pageNum": page_num,
                "pageSize": page_size,
                "column": column,
                "tabName": "fulltext",
                "plate": "",
                "stock": stock_str,
                "searchkey": "",
                "secid": "",
                "category": "",
                "trade": "",
                "seDate": se_date,
                "sortName": "",
                "sortType": "",
                "isHLtitle": "true",
            }

            try:
                resp = self.session.post(
                    f"{self.base_url}/fulltext",
                    data=payload,
                    timeout=self.timeout,
                )
                resp.raise_for_status()
                data = resp.json()
            except requests.RequestException as e:
                logger.error("cninfo request failed (page %d): %s", page_num, e)
                break
            except ValueError:
                logger.error("cninfo returned non-JSON response")
                break

            class_info = data.get("classifiedAnnouncements", [])
            announcements = data.get("announcements", [])

            if not announcements:
                break

            for ann in announcements:
                pub_time_str = ann.get("announcementTime", "")
                # cninfo returns timestamp in milliseconds
                if isinstance(pub_time_str, (int, float)):
                    pub_dt = datetime.fromtimestamp(pub_time_str / 1000)
                else:
                    try:
                        pub_dt = datetime.strptime(pub_time_str, "%Y-%m-%d %H:%M")
                    except (ValueError, TypeError):
                        pub_dt = end_time

                if pub_dt < start_time:
                    continue
                if pub_dt > end_time:
                    continue

                results.append({
                    "stock_code": ann.get("secCode", ""),
                    "stock_name": ann.get("secName", ""),
                    "title": ann.get("announcementTitle", "").replace("<em>", "").replace("</em>", ""),
                    "publish_time": pub_dt.strftime("%Y-%m-%d %H:%M:%S"),
                    "url": f"http://www.cninfo.com.cn/new/disclosure/detail?annoId={ann.get('announcementId', '')}",
                    "category": ann.get("announcementType", "other"),
                    "source": "cninfo",
                    "pdf_url": f"http://static.cninfo.com.cn/{ann.get('adjunctUrl', '')}",
                })

            # Check if there are more pages
            total_ann = data.get("totalAnnouncement", 0)
            if page_num * page_size >= total_ann:
                break

            page_num += 1
            time.sleep(0.5)  # Rate limiting

        return results
