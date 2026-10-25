class BrowserTools:
    ret = ""

    @classmethod
    def print_result(cls):
        print(cls.ret)

    @classmethod
    def env_info(cls):
        cls.ret = "None"

    # @classmethod
    # def show_all_tabs(cls):
    #     cls.ret = "Browser not found"
    #     for attempt in range(3):
    #         with sync_playwright() as p:
    #             try:
    #                 browser = p.chromium.connect_over_cdp(cls.remote_debugging_url)
    #                 if not browser:
    #                     continue
    #                 context = browser.contexts[0]
    #                 # 获取所有窗口名称
    #                 cls.ret = 'Browser Tabs: '
    #                 for idx, page in enumerate(context.pages):
    #                     cls.ret += f"{idx}. {page.title()} ({page.url})" + '\n'
    #                 return cls.ret
    #             except TimeoutError:
    #                 cls.ret = 'Failed to get browser tabs'
    #                 return None
    #     return None

    @classmethod
    def open_profile_settings(cls):
        """
        Open the profile settings page in the browser.
        """
        return {"action_type": "OPEN_CHROME_TAB", "parameters": {"urls_to_open": ["chrome://settings/people"]}}

    @classmethod
    def open_password_settings(cls):
        """
        Open the password settings page in the browser.
        """
        return {"action_type": "OPEN_CHROME_TAB", "parameters": {"urls_to_open": ["chrome://settings/autofill"]}}

    @classmethod
    def open_privacy_settings(cls):
        """
        Open the privacy settings page in the browser.
        """
        return {"action_type": "OPEN_CHROME_TAB", "parameters": {"urls_to_open": ["chrome://settings/privacy"]}}

    @classmethod
    def open_appearance_settings(cls):
        """
        Open the appearance settings page in the browser.
        """
        return {"action_type": "OPEN_CHROME_TAB", "parameters": {"urls_to_open": ["chrome://settings/appearance"]}}

    @classmethod
    def open_search_engine_settings(cls):
        """
        Open the search engine settings page in the browser.
        """
        return {"action_type": "OPEN_CHROME_TAB", "parameters": {"urls_to_open": ["chrome://settings/search"]}}

    @classmethod
    def bring_back_last_tab(cls):
        """
        Bring back the last tab in the browser.
        """
        return f"import pyautogui; pyautogui.hotkey('ctrl', 'shift', 't'); print('Brought back last tab')"

    @classmethod
    def print(cls):
        """
        Open the print option in current page.
        """
        return f"import pyautogui; pyautogui.hotkey('ctrl', 'p'); print('Opened print option')"

    @classmethod
    def delete_browsing_data(cls):
        """
        Delete browsing data in the browser.
        """
        return f"import pyautogui; pyautogui.hotkey('ctrl', 'shift', 'del'); print('Deleted browsing data')"

    @classmethod
    def open_extensions(cls):
        """
        open the extensions page in the browser.
        """
        return {"action_type": "OPEN_CHROME_TAB", "parameters": {"urls_to_open": ["chrome://extensions"]}}

    @classmethod
    def bookmark_page(cls):
        """
        Bookmark the current page in the browser.
        """
        return f"import pyautogui; pyautogui.hotkey('ctrl', 'd'); print('Bookmarked page')"

    @classmethod
    def open_bookmarks(cls):
        """
        Open the bookmarks page in the browser.
        """
        return {"action_type": "OPEN_CHROME_TAB", "parameters": {"urls_to_open": ["chrome://bookmarks"]}}
