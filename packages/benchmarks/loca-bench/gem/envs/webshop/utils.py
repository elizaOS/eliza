import bisect
import json
import random
import time
from collections import defaultdict

import numpy as np
from datasets import load_dataset
from flask import Flask

from .web_agent_site.engine.engine import (
    ACTION_TO_TEMPLATE,
    BACK_TO_SEARCH,
    END_BUTTON,
    NEXT_PAGE,
    PREV_PAGE,
    generate_product_prices,
    get_goal_by_idx,
    get_product_by_asin,
    get_product_per_page,
    get_top_n_product_from_keywords,
    get_weights,
    init_search_engine,
    map_action_to_html,
)
from .web_agent_site.engine.goal import get_reward

app = Flask(__name__)


def random_idx(cum_weights):
    """Generate random index by sampling uniformly from sum of all weights, then
    selecting the `min` between the position to keep the list sorted (via bisect)
    and the value of the second to last index
    """
    pos = random.uniform(0, cum_weights[-1])
    idx = bisect.bisect(cum_weights, pos)
    idx = min(idx, len(cum_weights) - 2)
    return idx


def load_products():
    all_products = load_dataset("axon-rl/webshop", split="train").to_list()
    for p in all_products:
        for k, v in p.items():
            try:
                p[k] = json.loads(v)
            except Exception:
                pass
    product_item_dict = {item["asin"]: item for item in all_products}
    product_prices = generate_product_prices(all_products)
    attribute_to_asins = defaultdict(set)

    for p in all_products:
        for a in p["Attributes"]:
            attribute_to_asins[a].add(p["asin"])
    return all_products, product_item_dict, product_prices, attribute_to_asins


class SimServer:
    """Lightweight simulator of WebShop Flask application for generating HTML observations"""

    def __init__(
        self,
        base_url,
        split,
        show_attrs=False,
    ):
        """
        Constructor for simulated server serving WebShop application

        Arguments:
        filter_goals (`func`) -- Select specific goal(s) for consideration based on criteria of custom function
        limit_goals (`int`) -- Limit to number of goals available
        num_products (`int`) -- Number of products to search across
        human_goals (`bool`) -- If true, load human goals; otherwise, load synthetic goals
        """
        # Load all products, goals, and search engine
        self.base_url = base_url
        self.split = split
        self.search_engine = init_search_engine()
        self.show_attrs = show_attrs

        # Set extraneous housekeeping variables
        weights = get_weights(split)
        self.cum_weights = [0] + np.cumsum(weights).tolist()
        self.user_sessions = dict()
        self.search_time = 0
        self.render_time = 0
        self.sample_time = 0
        self.assigned_instruction_text = None  # TODO: very hacky, should remove

    @app.route("/", methods=["GET", "POST"])
    def index(self, session_id, **kwargs):
        """Redirect to the search page with the given session ID"""
        html = map_action_to_html(
            "start",
            session_id=session_id,
            instruction_text=kwargs["instruction_text"],
        )
        url = f"{self.base_url}/{session_id}"
        return html, url

    @app.route("/", methods=["GET", "POST"])
    def search_results(self, session_id, **kwargs):
        """Initialize session and return the search results page"""
        session = self.user_sessions[session_id]
        keywords = kwargs[
            "keywords"
        ]  # TODO: why is this using kwargs? why not session?
        assert isinstance(keywords, list)
        page = 1 if "page" not in kwargs else kwargs["page"]
        session["page"] = page
        session["keywords"] = keywords
        session["actions"]["search"] += 1
        session["asin"] = None
        session["options"] = {}

        # Perform search on keywords from items and record amount of time it takes
        old_time = time.time()
        top_n_products = get_top_n_product_from_keywords(keywords, self.search_engine)
        self.search_time += time.time() - old_time

        # Get product list from search result asins and get list of corresponding URLs
        products = get_product_per_page(top_n_products, page)

        keywords_url_string = "+".join(keywords)
        url = (
            f"{self.base_url}/search_results/{session_id}/{keywords_url_string}/{page}"
        )

        # Render HTML search page and record amount of time taken
        old_time = time.time()
        html = map_action_to_html(
            "search",
            session_id=session_id,
            products=products,
            keywords=session["keywords"],
            page=page,
            total=len(top_n_products),
            instruction_text=session["goal"]["instruction_text"],
        )
        self.render_time += time.time() - old_time
        return html, url

    @app.route("/", methods=["GET", "POST"])
    def item_page(self, session_id, **kwargs):
        """Render and return the HTML for a product item page"""
        session = self.user_sessions[session_id]
        clickable_name = kwargs["clickable_name"]
        text_to_clickable = kwargs["text_to_clickable"]
        clickable = text_to_clickable[clickable_name]

        # Update session logs with information of last product asin selected
        if (
            clickable.get("class") is not None
            and clickable.get("class")[0] == "product-link"
        ):
            session["asin"] = clickable_name.upper()
            session["actions"]["asin"] += 1
            session["asins"].add(session["asin"])
        elif clickable.get("name") is not None:
            clickable_key = clickable["name"].lower()
            session["options"][clickable_key] = clickable_name
            session["actions"]["options"] += 1

        # Set fields + url of page, then render page's HTML
        product_info = get_product_by_asin(session["asin"])
        keywords_url_string = "+".join(session["keywords"])
        option_string = json.dumps(session["options"])

        url = (
            f"{self.base_url}/item_page/{session_id}/"
            f"{session['asin']}/{keywords_url_string}/"
            f"{session['page']}/{option_string}"
        )

        html = map_action_to_html(
            "click",
            session_id=session_id,
            product_info=product_info,
            keywords=session["keywords"],
            page=session["page"],
            asin=session["asin"],
            options=session["options"],
            instruction_text=session["goal"]["instruction_text"],
            show_attrs=self.show_attrs,
        )
        return html, url

    @app.route("/", methods=["GET", "POST"])
    def item_sub_page(self, session_id, **kwargs):
        """Render and return the HTML for a product's sub page (i.e. description, features)"""
        session = self.user_sessions[session_id]
        clickable_name = kwargs["clickable_name"]
        for k in ACTION_TO_TEMPLATE:
            if clickable_name.lower() == k.lower():
                clickable_name = k
                break

        # Set fields + url of page, then render page's HTML
        product_info = get_product_by_asin(session["asin"])
        session["actions"][clickable_name] += 1
        keywords_url_string = "+".join(session["keywords"])
        url = (
            f"{self.base_url}/item_sub_page/{session_id}/"
            f"{session['asin']}/{keywords_url_string}/{session['page']}/"
            f"{clickable_name}/{session['options']}"
        )
        html = map_action_to_html(
            f"click[{clickable_name}]",
            session_id=session_id,
            product_info=product_info,
            keywords=session["keywords"],
            page=session["page"],
            asin=session["asin"],
            options=session["options"],
            instruction_text=session["goal"]["instruction_text"],
        )
        return html, url

    @app.route("/", methods=["GET", "POST"])
    def done(self, session_id, **kwargs):
        """Render and return HTML for done page"""
        session = self.user_sessions[session_id]
        goal = self.user_sessions[session_id]["goal"]
        purchased_product = get_product_by_asin(session["asin"])
        session["actions"]["purchase"] += 1
        price = float(get_product_by_asin(session["asin"])["pricing"])

        # Calculate reward for selected product and set variables for page details
        reward, info = get_reward(
            purchased_product,
            goal,
            price=price,
            options=session["options"],
            verbose=True,
        )

        self.user_sessions[session_id]["verbose_info"] = info
        self.user_sessions[session_id]["done"] = True
        self.user_sessions[session_id]["reward"] = reward

        url = (
            f"{self.base_url}/done/{session_id}/{session['asin']}/{session['options']}"
        )
        html = map_action_to_html(
            f"click[{END_BUTTON}]",
            session_id=session_id,
            reward=reward,
            asin=session["asin"],
            options=session["options"],
            instruction_text=session["goal"]["instruction_text"],
        )
        return html, url, reward

    def receive(self, session_id, current_url, session_int=None, **kwargs):
        """Map action to the corresponding page"""
        status = dict(reward=0.0, done=False)

        with app.app_context(), app.test_request_context():
            # Create/determine goal, instruction_text from current session
            if session_id not in self.user_sessions:
                idx = (
                    session_int
                    if (session_int is not None and isinstance(session_int, int))
                    else random_idx(self.cum_weights)
                )
                goal = get_goal_by_idx(idx, split=self.split)
                instruction_text = goal["instruction_text"]
                self.user_sessions[session_id] = {"goal": goal, "done": False}
            else:
                instruction_text = self.user_sessions[session_id]["goal"][
                    "instruction_text"
                ]
            if self.assigned_instruction_text is not None:
                instruction_text = (
                    self.assigned_instruction_text
                )  # TODO: very hacky, should remove
                self.user_sessions[session_id]["goal"][
                    "instruction_text"
                ] = instruction_text
            session = self.user_sessions[session_id]

            if not kwargs:
                # If no action, reset the session variables
                kwargs["instruction_text"] = instruction_text
                html, url = self.index(session_id, **kwargs)
                self.user_sessions[session_id].update(
                    {
                        "keywords": None,
                        "page": None,
                        "asin": None,
                        "asins": set(),
                        "options": dict(),
                        "actions": defaultdict(int),
                    }
                )
            elif "keywords" in kwargs:
                # If search keywords are available, run a search
                html, url = self.search_results(session_id, **kwargs)
            elif "clickable_name" in kwargs:
                clickable_name = kwargs["clickable_name"].lower()
                if clickable_name == END_BUTTON.lower():
                    # If "buy now" clicked, calculate reward and flag session as terminated
                    html, url, reward = self.done(session_id, **kwargs)
                    status["reward"] = reward
                    status["done"] = True
                elif clickable_name == BACK_TO_SEARCH.lower():
                    # If "back to search" clicked, recursively reset the session back to search page
                    html, url, status = self.receive(session_id, current_url)
                elif (
                    clickable_name == NEXT_PAGE.lower()
                    and self.get_page_name(current_url) == "search_results"
                ):
                    # If "next page" clicked from search results, re-render with `page` enumerated
                    html, url, status = self.receive(
                        session_id,
                        current_url,
                        keywords=session["keywords"],
                        page=session["page"] + 1,
                    )
                elif (
                    clickable_name == PREV_PAGE.lower()
                    and self.get_page_name(current_url) == "search_results"
                ):
                    # If "prev page" clicked from search results, re-render with `page` denumerated
                    html, url, status = self.receive(
                        session_id,
                        current_url,
                        keywords=session["keywords"],
                        page=session["page"] - 1,
                    )
                elif (
                    clickable_name == PREV_PAGE.lower()
                    and self.get_page_name(current_url) == "item_sub_page"
                ):
                    # If "prev page" clicked from sub page, return to corresponding item page
                    html, url = self.item_page(session_id, **kwargs)
                elif (
                    clickable_name == PREV_PAGE.lower()
                    and self.get_page_name(current_url) == "item_page"
                ):
                    # If "prev page" clicked from item page, return to search results page
                    html, url = self.search_results(
                        session_id,
                        keywords=session["keywords"],
                        page=session["page"],
                        **kwargs,
                    )
                elif clickable_name in [k.lower() for k in ACTION_TO_TEMPLATE]:
                    # Render item_sub_page if clickable is description, features, or reviews
                    html, url = self.item_sub_page(session_id, **kwargs)
                else:
                    # Otherwise, render current item page
                    html, url = self.item_page(session_id, **kwargs)
            return html, url, status

    def get_page_name(self, url):
        """Determine which page (i.e. item_page, search_results) the given URL is pointing at"""
        if url is None:
            return None
        page_names = ["search_results", "item_page", "item_sub_page", "done"]
        for page_name in page_names:
            if page_name in url:
                return page_name
        return ""  # index page


class SimBrowser:
    """Simulated browser for rendering the HTML source of WebShop environment pages"""

    def __init__(self, server):
        self.server = server
        self.current_url = None
        self.page_source = None
        self.session_id = None

    def get(self, url, session_id=None, session_int=None):
        """Set browser variables to corresponding link, page HTML for URL"""
        self.session_id = url.split("/")[-1] if session_id is None else session_id
        self.page_source, _, _ = self.server.receive(
            self.session_id, self.current_url, session_int=session_int
        )
        self.current_url = url

    def click(self, clickable_name, text_to_clickable):
        """Wrapper for `receive` handler for performing click action on current page"""
        self.page_source, self.current_url, status = self.server.receive(
            self.session_id,
            current_url=self.current_url,
            clickable_name=clickable_name,
            text_to_clickable=text_to_clickable,
        )
        return status

    def search(self, keywords):
        """Wrapper for `receive` handler for performing search action on current page"""
        if isinstance(keywords, str):
            keywords = keywords.split(" ")
        self.page_source, self.current_url, status = self.server.receive(
            self.session_id,
            current_url=self.current_url,
            keywords=keywords,
        )
        return status
