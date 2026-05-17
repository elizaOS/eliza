"""DOM utilities vendored from OSU-NLP-Group/Mind2Web.

Source: https://github.com/OSU-NLP-Group/Mind2Web/blob/main/src/data_utils/dom_utils.py
        https://github.com/OSU-NLP-Group/Mind2Web/blob/main/src/candidate_generation/dataloader.py
        (``format_candidate`` only)
License: Apache 2.0
Copyright (c) The Ohio State University NLP Group

This module contains the small subset of DOM manipulation helpers needed to
reproduce the MindAct stage-1 candidate-ranking input format. It is intentionally
isolated so that the rest of the benchmark code does not need to depend on the
upstream package layout.

The functions exported here are byte-for-byte equivalent to the upstream
implementation except for trivial formatting changes.
"""

from __future__ import annotations

import copy
import re
from typing import Any

from lxml import etree


_SALIENT_ATTRIBUTES = {
    "alt",
    "aria_description",
    "aria_label",
    "aria_role",
    "input_checked",
    "input_value",
    "label",
    "name",
    "option_selected",
    "placeholder",
    "role",
    "text_value",
    "title",
    "type",
    "value",
}


def clean_text(text: str | None) -> str:
    if text is None:
        return ""
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def get_descendants(node: Any, max_depth: int, current_depth: int = 0) -> list[Any]:
    if current_depth > max_depth:
        return []

    descendants: list[Any] = []
    for child in node:
        descendants.append(child)
        descendants.extend(get_descendants(child, max_depth, current_depth + 1))

    return descendants


def prune_tree(
    dom_tree: Any,
    candidate_set: list[str] | set[str],
    max_depth: int = 5,
    max_children: int = 50,
    max_sibling: int = 3,
) -> Any:
    """Return a pruned copy of ``dom_tree`` keeping only context near candidates."""
    nodes_to_keep: set[str] = set()
    for candidate_id in candidate_set:
        matches = dom_tree.xpath(f'//*[@backend_node_id="{candidate_id}"]')
        if not matches:
            continue
        candidate_node = matches[0]
        nodes_to_keep.add(candidate_node.attrib["backend_node_id"])
        nodes_to_keep.update(
            x.attrib.get("backend_node_id", "") for x in candidate_node.xpath("ancestor::*")
        )
        nodes_to_keep.update(
            [
                x.attrib.get("backend_node_id", "")
                for x in get_descendants(candidate_node, max_depth)
            ][:max_children]
        )
        parent = candidate_node.getparent()
        if parent is not None:
            siblings = [x for x in parent.getchildren() if x.tag != "text"]
            if candidate_node in siblings:
                idx_in_sibling = siblings.index(candidate_node)
                nodes_to_keep.update(
                    x.attrib.get("backend_node_id", "")
                    for x in siblings[
                        max(0, idx_in_sibling - max_sibling) : idx_in_sibling + max_sibling + 1
                    ]
                )
    new_tree = copy.deepcopy(dom_tree)
    for node in new_tree.xpath("//*")[::-1]:
        if node.tag != "text":
            is_keep = node.attrib.get("backend_node_id", "") in nodes_to_keep
            is_candidate = node.attrib.get("backend_node_id", "") in candidate_set
        else:
            parent = node.getparent()
            is_keep = parent is not None and parent.attrib.get("backend_node_id", "") in nodes_to_keep
            is_candidate = (
                parent is not None and parent.attrib.get("backend_node_id", "") in candidate_set
            )
        if not is_keep and node.getparent() is not None:
            node.getparent().remove(node)
        else:
            if not is_candidate or node.tag == "text":
                node.attrib.pop("backend_node_id", None)
            if (
                len(node.attrib) == 0
                and not any(x.tag == "text" for x in node.getchildren())
                and node.getparent() is not None
                and node.tag != "text"
                and len(node.getchildren()) <= 1
            ):
                for child in node.getchildren():
                    node.addprevious(child)
                node.getparent().remove(node)
    return new_tree


def get_attribute_repr(node: Any, max_value_length: int = 5, max_length: int = 20) -> None:
    attr_values_set: set[str] = set()
    attr_values = ""
    for attr in [
        "role",
        "aria_role",
        "type",
        "alt",
        "aria_description",
        "aria_label",
        "label",
        "title",
        "name",
        "text_value",
        "value",
        "placeholder",
        "input_checked",
        "input_value",
        "option_selected",
        "class",
    ]:
        if attr in node.attrib and node.attrib[attr] is not None:
            value = node.attrib[attr].lower()
            if value in [
                "hidden",
                "none",
                "presentation",
                "null",
                "undefined",
            ] or value.startswith("http"):
                continue
            tokens = value.split()
            value = " ".join(v for v in tokens if len(v) < 15)
            value = " ".join(value.split()[:max_value_length])
            if value and value not in attr_values_set:
                attr_values_set.add(value)
                attr_values += value + " "
    uid = node.attrib.get("backend_node_id", "")
    node.attrib.clear()
    if uid:
        node.attrib["id"] = uid
    if attr_values:
        node.attrib["meta"] = " ".join(attr_values.split()[:max_length])


def get_tree_repr(
    tree: Any,
    max_value_length: int = 5,
    max_length: int = 20,
    id_mapping: dict[str, int] | None = None,
    keep_html_brackets: bool = False,
) -> tuple[str, dict[str, int]]:
    if id_mapping is None:
        id_mapping = {}
    if isinstance(tree, str):
        tree = etree.fromstring(tree)
    else:
        tree = copy.deepcopy(tree)
    for node in tree.xpath("//*"):
        if node.tag != "text":
            if "backend_node_id" in node.attrib:
                if node.attrib["backend_node_id"] not in id_mapping:
                    id_mapping[node.attrib["backend_node_id"]] = len(id_mapping)
                node.attrib["backend_node_id"] = str(id_mapping[node.attrib["backend_node_id"]])
            get_attribute_repr(node, max_value_length, max_length)
        else:
            if node.text:
                node.text = " ".join(node.text.split()[:max_length])
    tree_repr = etree.tostring(tree, encoding="unicode")

    tree_repr = tree_repr.replace('"', " ")
    tree_repr = tree_repr.replace("meta= ", "").replace("id= ", "id=").replace(" >", ">")
    tree_repr = re.sub(r"<text>(.*?)</text>", r"\1", tree_repr)
    if not keep_html_brackets:
        tree_repr = tree_repr.replace("/>", "$/$>")
        tree_repr = re.sub(r"</(.+?)>", r")", tree_repr)
        tree_repr = re.sub(r"<(.+?)>", r"(\1", tree_repr)
        tree_repr = tree_repr.replace("$/$", ")")

    html_escape_table = [
        ("&quot;", '"'),
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&nbsp;", " "),
        ("&ndash;", "-"),
        ("&rsquo;", "'"),
        ("&lsquo;", "'"),
        ("&ldquo;", '"'),
        ("&rdquo;", '"'),
        ("&#39;", "'"),
        ("&#40;", "("),
        ("&#41;", ")"),
    ]
    for k, v in html_escape_table:
        tree_repr = tree_repr.replace(k, v)
    tree_repr = re.sub(r"\s+", " ", tree_repr).strip()

    return tree_repr, id_mapping


def format_candidate(
    dom_tree: Any, backend_node_id: str, keep_html_brackets: bool = False
) -> str:
    """Format a single candidate as ``ancestors:`` + ``target:`` text.

    Mirrors ``src/candidate_generation/dataloader.py::format_candidate`` from the
    upstream repo. Returns "" if the candidate is not present in the tree.
    """
    node_tree = prune_tree(dom_tree, [backend_node_id])
    matches = node_tree.xpath("//*[@backend_node_id]")
    if not matches:
        return ""
    c_node = matches[0]
    if c_node.getparent() is not None:
        c_node.getparent().remove(c_node)
        ancestor_repr, _ = get_tree_repr(
            node_tree, id_mapping={}, keep_html_brackets=keep_html_brackets
        )
    else:
        ancestor_repr = ""
    subtree_repr, _ = get_tree_repr(
        c_node, id_mapping={}, keep_html_brackets=keep_html_brackets
    )
    if subtree_repr.strip():
        subtree_repr = " ".join(subtree_repr.split()[:100])
    else:
        subtree_repr = ""
    if ancestor_repr.strip():
        ancestor_repr = re.sub(r"\s*\(\s*", "/", ancestor_repr)
        ancestor_repr = re.sub(r"\s*\)\s*", "", ancestor_repr)
        ancestor_repr = " ".join(ancestor_repr.split()[-50:])
    else:
        ancestor_repr = ""
    return f"ancestors: {ancestor_repr}\n" + f"target: {subtree_repr}"
