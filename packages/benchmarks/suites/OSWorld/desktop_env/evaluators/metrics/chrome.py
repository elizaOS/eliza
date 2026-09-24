import logging
import os
import re
import shutil
import io
import time
from itertools import product
from typing import Any, Dict, List, Union

import rapidfuzz.fuzz as fuzz
from bs4 import BeautifulSoup, Tag

from desktop_env.evaluators.metrics.utils import are_lists_equal, compare_urls

logger = logging.getLogger("desktopenv.metrics.chrome")


def is_expected_active_tab(active_tab_info: Dict[str, str], rule: Dict[str, Any]) -> float:
    """
    Checks if the expected active tab is open in Chrome.
    """
    if not active_tab_info:
        return 0.

    match_type = rule['type']

    if match_type == "url":
        expected_url = rule['url']
        if isinstance(active_tab_info, Dict):
            actual_url = active_tab_info.get('url', None)
        else:
            actual_url = active_tab_info
        logger.info("expected_url: {}".format(expected_url))
        logger.info("actual_url: {}".format(actual_url))
        return 1 if compare_urls(expected_url, actual_url) else 0
    else:
        logger.error(f"Unknown type: {match_type}")
        return 0


def is_expected_active_tab_approximate(active_tab_info: Dict[str, str], rule: Dict[str, Any]) -> float:
    """
    Checks if the expected active tab is open in Chrome, ignoring query parameters in the URL.
    """
    if not active_tab_info:
        return 0.

    match_type = rule['type']

    if match_type == "url":
        expected_url = rule['url']
        if isinstance(active_tab_info, Dict):
            actual_url = active_tab_info.get('url', None)
        else:
            actual_url = active_tab_info
        from urllib.parse import urlparse, urlunparse
        def strip_query(url):
            parsed = urlparse(url)
            return urlunparse(parsed._replace(query=""))
        if strip_query(expected_url) == strip_query(actual_url):
            return 1
        else:
            return 0
    else:
        logger.error(f"Unknown type: {match_type}")
        return 0


# rules[expected] is a string-formatted regex
def is_expected_url_pattern_match(result, rules) -> float:
    """
    This function is used to search the expected pattern in the url using regex.
    result is the return value of function "activte_tab_info" or return value of function "get_active_url_from_accessTree"   
    """
    if not result:
        return 0.

    # Extract URL from result parameter - result can be either a string URL or a dict with 'url' field
    if isinstance(result, str):
        result_url = result
        logger.info("result url: {}".format(result_url))
    elif isinstance(result, dict) and 'url' in result:
        result_url = result['url']
        logger.info("result url: {}".format(result_url))
    else:
        logger.error(f"Invalid result format: {type(result)}, expected string URL or dict with 'url' field")
        return 0.

    logger.info(f"Result URL to match: {result_url}")
    
    # expect_regex = re.compile(rules["expected"])
    patterns = rules["expected"]
    logger.info("expected_regex: {}".format(patterns))
    for pattern in patterns:
        match = re.search(pattern, result_url)
        logger.info("match: {}".format(match))
        if not match:
            return 0.
    return 1.


def is_expected_installed_extensions(installed_extensions, expected) -> float:
    if not installed_extensions:
        return 0.

    logger.info("installed_extensions: ")
    logger.info(installed_extensions)
    expected_extensions = expected["expected"]

    # whether the expected extensions are installed
    set_expected_extensions = set(expected_extensions)
    set_installed_extensions = set(installed_extensions)

    if set_expected_extensions.issubset(set_installed_extensions):
        return 1.
    else:
        return 0.


def is_expected_tabs(open_tabs: List[Dict[str, str]], rule: Dict[str, Any]) -> float:
    """
    Checks if the expected tabs are open in Chrome.
    """
    if not open_tabs:
        return 0.

    match_type = rule['type']

    if match_type == "url":
        expected_urls = rule['urls']
        actual_urls = [tab['url'] for tab in open_tabs]
        if not are_lists_equal(expected_urls, actual_urls, compare_urls):
            logger.error("list not match") 
            logger.error(expected_urls)
            logger.error(actual_urls)
            return 0
        return 1 if are_lists_equal(expected_urls, actual_urls, compare_urls) else 0
    else:
        logger.error(f"Unknown type: {match_type}")
        return 0


def is_expected_bookmarks(bookmarks: List[str], rule: Dict[str, Any]) -> float:
    """
    Checks if the expected bookmarks are in Chrome.
    """
    if not bookmarks:
        return 0.
    elif rule['type'] == "bookmark_bar_folders_names":
        bookmark_bar_folders_names = [bookmark['name'] for bookmark in bookmarks['bookmark_bar']['children'] if
                                      bookmark['type'] == 'folder']
        return 1. if set(bookmark_bar_folders_names) == set(rule['names']) else 0.
    elif rule['type'] == "bookmark_bar_websites_urls":
        bookmark_bar_websites_urls = [bookmark['url'] for bookmark in bookmarks['bookmark_bar']['children'] if
                                      bookmark['type'] == 'url']
        return 1. if set(bookmark_bar_websites_urls) == set(rule['urls']) else 0.
    elif rule['type'] == "liked_authors_websites_urls":
        # Check if "liked authors" folder exists
        liked_authors_folder = next((bookmark for bookmark in bookmarks['bookmark_bar']['children'] if
                                     bookmark['type'] == 'folder' and bookmark['name'] == 'Liked Authors'), None)
        if liked_authors_folder:
            # Check if it contains the specified URLs
            logger.info("'Liked Authors' folder exists")
            liked_authors_urls = [bookmark['url'] for bookmark in liked_authors_folder['children'] if
                                  bookmark['type'] == 'url']
            logger.info("Here is the 'Liked Authors' folder's urls: {}".format(liked_authors_urls))

            urls = rule['urls']

            for idx, url in enumerate(urls):
                if isinstance(url, str):
                    urls[idx] = [url]

            combinations = product(*urls)

            for combination in combinations:
                if set(combination) == set(liked_authors_urls):
                    return 1.
            return 0.
        else:
            return 0.
    else:
        raise TypeError(f"{rule['type']} not support yet!")


def is_expected_search_query(active_tab_info: Dict[str, str], rules: Dict[str, Any]) -> float:
    if not active_tab_info:
        return 0.

    expected = rules['expect']
    pattern = expected['pattern']
    matched = re.search(pattern, active_tab_info['url'])
    if matched:
        return 1.
    return 0.


def compare_pdfs(pdf1_path: Union[str, List[str]], pdf2_path: Union[str, List[str]]):
    """
    Compare two PDF files.
    """
    if type(pdf2_path) != list:
        pdf1_path, pdf2_path = [pdf1_path], [pdf2_path]

    def extract_text_from_pdf(pdf_path):
        """Extract text from each page of the PDF."""
        text = ""
        with fitz.open(pdf_path) as pdf:
            for page in pdf:
                text += page.get_text()
        return text.strip()

    score = 0.
    for path1, path2 in zip(pdf1_path, pdf2_path):
        try:
            text1 = extract_text_from_pdf(path1)
            text2 = extract_text_from_pdf(path2)
            score += fuzz.ratio(text1, text2) / 100
        except Exception as e:
            logger.info(f"[ERROR]: unexpected error occurred when comparing PDF files: {e}")
    return score / len(pdf2_path)


import fitz
from PIL import Image
from borb.pdf import Document
from borb.pdf import PDF
import imagehash

from pathlib import Path
import typing
import time


def compare_pdf_images(pdf1_path: str, pdf2_path: str, **kwargs) -> float:
    if not pdf1_path or not pdf2_path:
        return 0.
    if not all(map(os.path.exists, [pdf1_path, pdf2_path])):
        logger.warning(f"PDF file does not exist: {pdf1_path} or {pdf2_path}")
        return 0.

    def extract_images_from_pdf(pdf_path):
        pdf_document = fitz.open(pdf_path)
        images = []

        for page_number in range(pdf_document.page_count):
            page = pdf_document[page_number]
            for img_index, img in enumerate(page.get_images(full=True)):
                xref = img[0]
                base_image = pdf_document.extract_image(xref)
                image_bytes = base_image["image"]
                
                # convert to PIL Image
                try:
                    pil_image = Image.open(io.BytesIO(image_bytes))
                    images.append(pil_image)
                except Exception as e:
                    logger.error(f"Failed to process image in {pdf_path} on page {page_number}: {e}")

        return images
    
    temp_dir = Path(pdf1_path).parent / "temp_pdf_comparison"
    os.makedirs(temp_dir, exist_ok=True)
    
    temp_pdf1 = temp_dir / Path(pdf1_path).name
    temp_pdf2 = temp_dir / Path(pdf2_path).name

    shutil.copy(pdf1_path, temp_pdf1)
    shutil.copy(pdf2_path, temp_pdf2)

    try:
        images1 = extract_images_from_pdf(str(temp_pdf1))
        images2 = extract_images_from_pdf(str(temp_pdf2))
    except Exception as e:
        logger.error(f"Error extracting images from PDFs: {e}")
        shutil.rmtree(temp_dir)
        return 0.
    finally:
        shutil.rmtree(temp_dir)


    if len(images1) != len(images2):
        logger.info(f"Different number of images found. Gold: {len(images1)}, Pred: {len(images2)}")
        return 0.

    if not images1:
        logger.info("No images found in either PDF. Considering it a match.")
        return 1.0

    hash_threshold = 5 
    total_score = 0
    for i, (img1, img2) in enumerate(zip(images1, images2)):
        hash1 = imagehash.phash(img1)
        hash2 = imagehash.phash(img2)
        hash_diff = hash1 - hash2
        
        logger.info(f"Image {i+1}: Gold hash: {hash1}, Pred hash: {hash2}, Hash difference: {hash_diff}")

        if hash_diff <= hash_threshold:
            total_score +=1
    
    return total_score / len(images1)


def compare_archive(pred_path: str, gold_path: str, **kwargs) -> float:
    """
    Compare two archives. Note that the files in the archives should be of the same type.
    """
    file_path = kwargs.pop('file_path', '')

    if not pred_path:
        return 0.
    pred_folder = os.path.splitext(pred_path)[0] + '_pred'
    gold_folder = os.path.splitext(gold_path)[0] + '_gold'

    if os.path.exists(pred_folder):  # remove existing folder for new predictions
        shutil.rmtree(pred_folder, ignore_errors=True)
    os.makedirs(pred_folder)
    shutil.unpack_archive(pred_path, pred_folder)

    if not os.path.exists(gold_folder):  # use cache if exists
        os.makedirs(gold_folder)
        shutil.unpack_archive(gold_path, gold_folder)

    pred_files = sorted(os.listdir(os.path.join(pred_folder, file_path)))
    gold_files = sorted(os.listdir(os.path.join(gold_folder, file_path)))

    if pred_files != gold_files:
        return 0.

    def get_compare_function():
        file_type = kwargs.pop('file_type', 'text')
        if file_type == 'text':
            from .vscode import compare_text_file
            return compare_text_file
        elif file_type == 'pdf':
            return compare_pdfs
        elif file_type == 'docx':
            from .docs import compare_docx_files
            return compare_docx_files
        elif file_type == 'ppt':
            from .slides import compare_pptx_files
            return compare_pptx_files
        elif file_type == 'image':
            from .vlc import compare_images
            return compare_images
        elif file_type == 'csv':
            from .table import compare_csv
            return compare_csv
        elif file_type == 'table':
            from .table import compare_table
            return compare_table
        elif file_type == 'audio':
            from .vlc import compare_audios
            return compare_audios
        elif file_type == 'video':
            from .vlc import compare_videos
            return compare_videos
        else:
            raise ValueError('[ERROR]: not support file type: %s' % file_type)

    score = 0
    compare_function = get_compare_function()
    for f1, f2 in zip(pred_files, gold_files):
        fp1 = os.path.join(pred_folder, file_path, f1)
        fp2 = os.path.join(gold_folder, file_path, f2)
        score += compare_function(fp1, fp2, **kwargs)
    return score / len(pred_files)


def compare_htmls(html_path1: str, html_path2: str, **options) -> float:
    """
    Compare two HTML files.
    """
    with open(html_path1, 'r', encoding='utf-8') as inf:
        soup1 = BeautifulSoup(inf, 'lxml')
    with open(html_path2, 'r', encoding='utf-8') as inf:
        soup2 = BeautifulSoup(inf, 'lxml')
    ignore_sdnum = options.get("ignore_sdnum", None)

    def compare_elements(elem1, elem2):
        if not (isinstance(elem1, Tag) and isinstance(elem2, Tag)):
            if elem1 != elem2:
                logger.info("not the same")
            return elem1 == elem2
        if elem1.name != elem2.name:
            logger.info("html name not match")
            return False
        if elem1.text.strip() != elem2.text.strip():
            logger.info("html text not match")
            return False
        if elem1.attrs != elem2.attrs:
            if ignore_sdnum:
                attrs1 = {k: v for k, v in elem1.attrs.items() if k != 'sdnum'}
                attrs2 = {k: v for k, v in elem2.attrs.items() if k != 'sdnum'}
                return attrs1 == attrs2
            logger.info("html attrs not match")
            logger.info(f"{elem1.attrs}")
            logger.info(f"{elem2.attrs}")
            return False
        return True

    for elem1, elem2 in zip(soup1.recursiveChildGenerator(), soup2.recursiveChildGenerator()):
        if not compare_elements(elem1, elem2):
            logger.info("html not match")
            return .0
    return 1.


def is_cookie_deleted(cookie_data, rule):
    """
    Check if the cookie is deleted.
    """

    if rule['type'] == 'domains':
        cookies_domains = [cookie[1] for cookie in cookie_data]
        for domain in rule['domains']:
            for cookies_domain in cookies_domains:
                if compare_urls(domain, cookies_domain):
                    return 0.
        return 1.
    else:
        raise TypeError(f"{rule['type']} not support yet!")


def is_shortcut_on_desktop(shortcuts: Dict[str, str], rule):
    """
    Check if the shortcut is on the desktop.
    """
    logger.info(f"[SHORTCUT_CHECK] Checking shortcuts with rule: {rule}")
    logger.info(f"[SHORTCUT_CHECK] Found {len(shortcuts)} shortcuts on desktop")

    # fixme: if the name of the website changed in the future, this will not work; can be replaced with url
    if rule['type'] == 'name':
        expected_name = rule['name']
        logger.info(f"[SHORTCUT_CHECK] Looking for shortcut with name: {expected_name}")

        for shortcut_path, shortcut_content in shortcuts.items():
            logger.debug(f"[SHORTCUT_CHECK] Checking shortcut: {shortcut_path}")
            logger.debug(f"[SHORTCUT_CHECK] Shortcut content preview:\n{shortcut_content[:500]}")

            # Try exact match first
            exact_match = "Name=" + expected_name + "\n"
            if exact_match in shortcut_content:
                logger.info(f"[SHORTCUT_CHECK] ✓ Found exact name match in: {shortcut_path}")
                return 1.

            # Try flexible matching: extract Name line and compare
            lines = shortcut_content.split('\n')
            for line in lines:
                if line.startswith('Name='):
                    actual_name = line[5:]  # Remove 'Name=' prefix
                    logger.info(f"[SHORTCUT_CHECK] Found Name line: {actual_name}")

                    # Check exact match
                    if actual_name == expected_name:
                        logger.info(f"[SHORTCUT_CHECK] ✓ Exact name match found!")
                        return 1.
                    # Check if expected name is contained in actual name (case-insensitive)
                    elif expected_name.lower() in actual_name.lower():
                        logger.info(f"[SHORTCUT_CHECK] ✓ Expected name contained in actual name")
                        return 1.
                    # Check if actual name is contained in expected name (case-insensitive)
                    elif actual_name.lower() in expected_name.lower():
                        logger.info(f"[SHORTCUT_CHECK] ✓ Actual name contained in expected name")
                        return 1.

        logger.warning(f"[SHORTCUT_CHECK] ✗ No shortcut found with name: {expected_name}")
        return 0.0
    elif rule['type'] == 'exec':
        expected_exec = rule['exec']
        logger.info(f"[SHORTCUT_CHECK] Looking for Exec line: {expected_exec}")

        for shortcut_path, shortcut_content in shortcuts.items():
            logger.info(f"[SHORTCUT_CHECK] Checking shortcut: {shortcut_path}")
            logger.info(f"[SHORTCUT_CHECK] Full shortcut content:\n{shortcut_content}")

            # Try exact match first
            exact_match = "Exec=" + expected_exec + "\n"
            if exact_match in shortcut_content:
                logger.info(f"[SHORTCUT_CHECK] ✓ Found exact Exec match in: {shortcut_path}")
                return 1.

            # Extract Exec line from content for comparison
            lines = shortcut_content.split('\n')
            for line in lines:
                if line.startswith('Exec='):
                    actual_exec = line[5:]  # Remove 'Exec=' prefix
                    logger.info(f"[SHORTCUT_CHECK] Found Exec line in shortcut: {actual_exec}")
                    logger.info(f"[SHORTCUT_CHECK] Expected Exec: {expected_exec}")

                    # Check if they match (exact or contains)
                    if actual_exec == expected_exec:
                        logger.info(f"[SHORTCUT_CHECK] ✓ Exact match found!")
                        return 1.
                    elif expected_exec in actual_exec:
                        logger.info(f"[SHORTCUT_CHECK] ✓ Expected Exec is contained in actual Exec")
                        return 1.
                    elif actual_exec in expected_exec:
                        logger.info(f"[SHORTCUT_CHECK] ✓ Actual Exec is contained in expected Exec")
                        return 1.
                    else:
                        logger.warning(f"[SHORTCUT_CHECK] ✗ Exec lines don't match")
                        logger.warning(f"[SHORTCUT_CHECK]   Expected: {expected_exec}")
                        logger.warning(f"[SHORTCUT_CHECK]   Actual:   {actual_exec}")

        logger.error(f"[SHORTCUT_CHECK] ✗ No shortcut found with matching Exec: {expected_exec}")
        return 0.0
    elif rule['type'] == 'url':
        raise TypeError(f"{rule['type']} not support yet!")
    elif rule['type'] == 'id':
        raise TypeError(f"{rule['type']} not support yet!")
    else:
        raise TypeError(f"{rule['type']} not support yet!")


def check_history_deleted(history_data, rule):
    """
    Check if the history is deleted.
    """

    if rule['type'] == 'keywords':
        history_domains = [history[0] for history in history_data]
        for keyword in rule['keywords']:
            for history_domain in history_domains:
                if keyword in history_domain:
                    return 0.
        return 1.
    else:
        raise TypeError(f"{rule['type']} not support yet!")


def check_enabled_experiments(enabled_experiments, rule):
    """
    Check if the enabled experiments are as expected.
    """
    enabled_experiments_names = [experiment.split("@")[0] for experiment in enabled_experiments]

    if rule['type'] == 'names':
        return 1. if enabled_experiments_names == rule['names'] else 0.
    else:
        raise TypeError(f"{rule['type']} not support yet!")


def check_font_size(font_size, rule):
    """
    Check if the font size is as expected.
    """

    default_font_size = font_size['default_font_size']
    if rule['type'] == 'value':
        return 1. if default_font_size == rule['value'] else 0.
    elif rule['type'] == 'range':
        return 1. if rule['min'] < default_font_size < rule['max'] else 0.
    else:
        raise TypeError(f"{rule['type']} not support yet!")


def is_added_to_steam_cart(active_tab_info, rule):
    """
    Check if the item is added to the Steam cart.
    """
    items = rule['items']

    content = active_tab_info['content']

    for item in items:
        if item not in content:
            return 0.

    return 1.
