import os

from tailslib.django import SuspiciousFileOperation, safe_join
from tailslib.systemd import tor_has_bootstrapped

WEBSITE_URL = "https://tails.net"
WEBSITE_LOCAL_PATH = "/usr/share/doc/tails/website"
LANG_CODE = os.getenv("LANG", "en")[0:2]


class DocumentationPageNotFound(ValueError):
    def __init__(self):
        super().__init__("error: could not find the requested documentation page")


def resolve(page: str, anchor: str = "", force_local: bool = False) -> str:
    page = page.removesuffix("/")
    # If possible, let's hand-off to our website, which should be the most
    # up-to-date option.
    if not force_local and tor_has_bootstrapped():
        # Open page in the user-configured language, if available
        if os.path.isfile(get_local_path(page, LANG_CODE)):
            uri = WEBSITE_URL + "/" + page + "/index." + LANG_CODE + ".html"
        else:
            uri = WEBSITE_URL + "/" + page
    else:
        uri = find_local_page(page, LANG_CODE)
        if not uri:
            raise DocumentationPageNotFound

    if anchor:
        uri = uri + "#" + anchor

    return uri


def resolve_if_tails_website(uri: str, force_local: bool = False) -> str:
    if uri.startswith(WEBSITE_URL + "/"):
        url = uri.removeprefix(WEBSITE_URL + "/")
        try:
            return resolve(*url.split("#", 1), force_local=force_local)
        except SuspiciousFileOperation:
            return uri
    return uri


def is_local_page(uri: str) -> bool:
    if uri.startswith(("file:///", "/")):
        uri = uri.removeprefix("file://")
        return os.path.exists(uri)
    return False


def find_local_page(page: str, lang: str) -> str:
    for lang_code in (lang, "en", None):
        local_page = get_local_path(page, lang_code)
        if os.path.isfile(local_page):
            return "file://" + local_page
    return ""


def get_local_path(page, lang_code: str) -> str:
    if lang_code:
        return safe_join(WEBSITE_LOCAL_PATH, page + "." + lang_code + ".html")
    else:
        return safe_join(WEBSITE_LOCAL_PATH, page + ".html")
