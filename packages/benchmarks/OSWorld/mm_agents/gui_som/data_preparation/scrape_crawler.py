import json
import os
import random
import time
import uuid
from multiprocessing import Pool

from playwright.sync_api import sync_playwright

from majestic_million_download import read_csv

# JavaScript code as a string
with open('get_tag_elem_dict.js', 'r') as f:
    get_tag_elem_dict_js_code = f.read()


def scrape_data(website_url, action_depth=10):
    # if file exists, skip
    if os.path.exists(os.path.join('collected_data', website_url.split("//")[1])):
        # print("Data already exists, skipping...")
        return

    def click_random_link(page):
        links = page.query_selector_all("a")
        if links:
            random_link = random.choice(links)
            try:
                page.evaluate("window.unmarkPage()")

                # Capture the initial HTML content of the body
                initial_content = page.inner_html("body")

                # Click the link and wait for potential navigation
                random_link.click()
                page.wait_for_timeout(5000)  # wait for 5 seconds to allow page changes to occur

                # Capture the new HTML content of the body
                new_content = page.inner_html("body")

                # Compare the contents
                if new_content != initial_content:
                    print("Content change detected.")
                    return True
                else:
                    print("No content change detected.")
                    return False

            except Exception as e:
                print("Error occurred:", e)
                return False
        else:
            print("No links found on the page.")
            return False

        return False

    with sync_playwright() as p:
        # Launch the browser
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width': 1920, 'height': 1080}, locale='en-US')
        context.set_extra_http_headers({'Accept-Language': 'en-US'})
        page = context.new_page()

        # Navigate to Google
        page.goto(website_url, timeout=60000, wait_until='networkidle')

        data_id = str(uuid.uuid4())
        data_dir = os.path.join('collected_data', website_url.split("//")[1], data_id)
        os.makedirs(data_dir, exist_ok=True)
        page.screenshot(path=os.path.join(data_dir, 'screenshot_0.png'))
        tag_elem_dict = page.evaluate(get_tag_elem_dict_js_code)
        with open(os.path.join(data_dir, 'meta_data_0.json'), 'w') as f:
            json.dump({
                'timestamp': time.time(),
                'url': website_url,
                'data_id': data_id,
                'tag_elem_dict': tag_elem_dict
            }, f, indent=4)
        page.screenshot(path=os.path.join(data_dir, 'screenshot_som_0.png'))

        for i in range(action_depth):
            if not click_random_link(page):
                print("Invalid click or no navigation, stopping random clicks.")
                break
            page.screenshot(path=os.path.join(data_dir, f'screenshot_{i + 1}.png'))
            tag_elem_dict = page.evaluate(get_tag_elem_dict_js_code)
            with open(os.path.join(data_dir, f'meta_data_{i + 1}.json'), 'w') as f:
                json.dump({
                    'timestamp': time.time(),
                    'url': website_url,
                    'data_id': data_id,
                    'tag_elem_dict': tag_elem_dict
                }, f, indent=4)
            page.screenshot(path=os.path.join(data_dir, f'screenshot_som_{i + 1}.png'))

        # Close the browser
        browser.close()


def run_one(url):
    try:
        scrape_data("https://" + url, action_depth=5)
        scrape_data("http://" + url, action_depth=5)
    except Exception as e:
        print("Error scraping data:", e)
        print("Start next one...")


def main():
    urls = read_csv("majestic_million.csv")[:20000]
    random.shuffle(urls)

    # Number of processes
    num_processes = 50  # Adjust based on your system's capability, on my i9-13900k, 50 processes can be used

    with Pool(num_processes) as pool:
        pool.map(run_one, urls)


if __name__ == '__main__':
    main()
