import random
import re
import string
from typing import Any, Optional, Tuple

import torch
from bs4 import BeautifulSoup
from bs4.element import Comment

from gem.core import Env
from gem.envs.webshop.utils import SimBrowser, SimServer
from gem.envs.webshop.web_agent_site.engine.engine import parse_action

WEBSHOP_INSTRUCTION_TEMPLATE = """
You are an expert autonomous agent operating in the WebShop e‑commerce environment.
Your task is to: {task_description}.
Prior to this step, you have already taken {step_count} step(s). Below are the history actions you took and the corresponding observation:\n
"""


class WebshopEnv(Env):
    def __init__(
        self,
        observation_mode="text",  # "html", "text", "text_rich", "url"
        split="train",
        max_turns=15,
        show_attrs=False,
        session=None,
        session_prefix=None,
        error_tolerance=0,
        format_error_reward=0,
        **_,
    ):
        super().__init__()
        self.observation_mode = observation_mode
        self.max_turns = max_turns
        self.base_url = "https://127.0.0.1:3000"
        self.error_tolerance = error_tolerance
        self.format_error_reward = format_error_reward
        self.server = SimServer(self.base_url, split, show_attrs)
        self.browser = SimBrowser(self.server)
        self.session = session
        self.session_prefix = session_prefix
        self.reset()

    def _get_instructions(self) -> str:
        return self.observation

    def get_task_suffix(self, **kwargs) -> str:
        available_actions = self.get_available_actions()
        actions = [
            f"click[{a}]" for a in available_actions["clickables"] if a != "search"
        ]
        if available_actions["has_search_bar"]:
            actions.append("search[<your query>]")
        return (
            "\nYour admissible actions of the current situation are:"
            f"{actions}\n"
            "Now it's your turn to take one action for the current step."
            "You should first reason step-by-step about the current situation, then think carefully which admissible action best advances the shopping goal."
            "Once you've finished your reasoning, you should choose an admissible action for current step and present it within \\boxed{}. For example, \\boxed{search[...]} or \\boxed{click[...]}."
        )

    def get_task_prefix(self):
        return WEBSHOP_INSTRUCTION_TEMPLATE.format(
            task_description=self.instruction_text, step_count=self.turn_count
        )

    def reset(
        self, seed: Optional[int] = None, session=None, instruction_text=None
    ) -> Tuple[str, dict[str, Any]]:
        """Create a new session and reset environment variables."""
        super().reset(seed)
        session_int = None
        if session is not None:
            self.session = str(session)
            if isinstance(session, int):
                session_int = session
        else:
            self.session = "".join(
                random.choices(random.choices(string.ascii_lowercase, k=10))
            )

        if self.session_prefix is not None:
            self.session = self.session_prefix + self.session

        init_url = f"{self.base_url}/session={self.session}"
        self.browser.get(init_url, session_id=self.session, session_int=session_int)

        self.text_to_clickable = None
        self.instruction_text = (
            self.get_instruction_text()
            if instruction_text is None
            else instruction_text
        )
        self.turn_count = 0
        self.error_turn_count = 0
        return self._get_instructions(), {
            "suffix": self.get_task_suffix(),
            "prefix": self.get_task_prefix(),
        }

    def parse_action(self, action: str) -> Tuple[str, Optional[str]]:
        action_search_pattern = re.compile(r"\\boxed{(.+)}")  # e.g. click[value]
        matches = list(action_search_pattern.finditer(action))
        if matches:
            return parse_action(matches[-1].group(1))
        else:
            return None, None

    def step(self, action: str) -> Tuple[str, float, bool, bool, dict[str, Any]]:
        """
        action should be of the following structure:
        - "click[value]"
        - "search[keywords]"
        """
        self.turn_count += 1
        info = {}
        self.get_available_actions()
        action_name, action_arg = self.parse_action(action)
        info["parsed_action"] = (
            f"{action_name}[{action_arg}]" if action_arg else f"{action_name}"
        )

        if action_name == "search" and action_arg is not None:
            status = self.browser.search(action_arg)
        elif (
            action_name == "click"
            and action_arg in self.text_to_clickable.keys()
            and action_arg != "search"
        ):
            status = self.browser.click(action_arg, self.text_to_clickable)
        else:  # invalid action
            self.error_turn_count += 1
            info["suffix"] = self.get_task_suffix()
            status = {
                "reward": self.format_error_reward,
                "done": self.error_turn_count > self.error_tolerance,
            }

        info.update(
            {"suffix": self.get_task_suffix(), "prefix": self.get_task_prefix()}
        )

        if self.turn_count >= self.max_turns:
            return self.observation, status["reward"], True, True, info

        return self.observation, status["reward"], status["done"], False, info

    def get_available_actions(self):
        """Returns list of available actions at the current step"""
        html_obj = self._parse_html()

        # Collect search bar, buttons, links, and options as clickables
        search_bar = html_obj.find(id="search_input")
        has_search_bar = True if search_bar is not None else False
        buttons = html_obj.find_all(class_="btn")
        product_links = html_obj.find_all(class_="product-link")
        buying_options = html_obj.select('input[type="radio"]')

        self.text_to_clickable = {
            f"{b.get_text()}".lower(): b for b in buttons + product_links
        }
        for opt in buying_options:
            opt_value = opt.get("value")
            self.text_to_clickable[f"{opt_value}"] = opt
        return dict(
            has_search_bar=has_search_bar,
            clickables=list(self.text_to_clickable.keys()),
        )

    def get_image(self):
        """Scrape image from page HTML and return as a list of pixel values"""
        html_obj = self._parse_html(self.browser.page_source)
        image_url = html_obj.find(id="product-image")
        if image_url is not None:
            image_url = image_url["src"]
            if image_url in self.ids:
                image_idx = self.ids[image_url]
                image = self.feats[image_idx]
                return image
        return torch.zeros(512)

    def get_instruction_text(self):
        """Get corresponding instruction text for current environment session"""
        html_obj = self._parse_html(self.browser.page_source)
        instruction_text = html_obj.find(id="instruction-text").h4.text
        if instruction_text.startswith("Instruction: "):
            instruction_text = instruction_text[len("Instruction: ") :]
        return instruction_text

    def _parse_html(self, html=None):
        """
        Returns web request result wrapped in BeautifulSoup object

        Arguments:
        url (`str`): If no url or html is provided, use the current
            observation (HTML) for parsing.
        """
        if html is None:
            html = self.state["html"]
        html_obj = BeautifulSoup(html, "html.parser")
        return html_obj

    @property
    def observation(self):
        """Compiles state into either the `html` or `text` observation mode"""
        html = self.state["html"]
        # obs_prefix = "Observation:\n "
        obs_prefix = ""
        if self.observation_mode == "html":
            obs = html
        elif self.observation_mode == "text":
            obs = self.convert_html_to_text(html, simple=True)
        elif self.observation_mode == "text_rich":
            obs = self.convert_html_to_text(html, simple=False)
        elif self.observation_mode == "url":
            obs = self.state["url"]
        else:
            raise ValueError(f"Observation mode {self.observation_mode} not supported.")
        return obs_prefix + obs

    @property
    def state(self):
        """
        State that includes all information. The actual observation are
        likely to be a subset or reduced form of the state.
        """
        return dict(
            url=self.browser.current_url,
            html=self.browser.page_source,
            instruction_text=self.instruction_text,
        )

    def convert_html_to_text(self, html, simple=False):
        """Strip HTML of tags and add separators to convert observation into simple mode"""
        texts = self._parse_html(html).findAll(text=True)
        visible_texts = filter(tag_visible, texts)
        if simple:
            # process the string following https://github.com/langfengQ/verl-agent/blob/d0b97244c50f17fb43a6ef0a15bca0e95a044ff7/agent_system/environments/env_manager.py#L434
            parts = [t.strip() for t in visible_texts if t != "\n"]
            try:
                index = parts.index(self.instruction_text)
                observation = " [SEP] ".join(parts[index + 1 :])
            except:
                observation = " [SEP] ".join(parts)
            return observation
        else:
            # Otherwise, return an observation with tags mapped to specific, unique separators
            observation = ""
            for t in visible_texts:
                if t == "\n" or t.strip() in [
                    self.instruction_text,
                    "Instruction:",
                    "Webshop",
                ]:
                    continue
                if t.parent.name == "button":  # button
                    processed_t = f"[button] {t} [button_]"
                elif t.parent.name == "label":  # options
                    if f'"{t}"' in self.state["url"]:
                        processed_t = f"  [clicked button] {t} [clicked button_]"
                        observation = f"You have clicked {t}.\n" + observation
                    else:
                        processed_t = f"  [button] {t} [button_]"
                elif t.parent.get("class") == ["product-link"]:  # product asins
                    if f"{t}" in self.server.user_sessions[self.session]["asins"]:
                        processed_t = f"\n[clicked button] {t} [clicked button_]"
                    else:
                        processed_t = f"\n[button] {t} [button_]"
                else:  # regular, unclickable text
                    processed_t = str(t)
                observation += processed_t + "\n"
            return observation


def tag_visible(element):
    ignore = {"style", "script", "head", "title", "meta", "[document]"}
    return element.parent.name not in ignore and not isinstance(element, Comment)
