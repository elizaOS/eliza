"""Checks the lossless product-to-Lucene projection used by full WebShop."""

from __future__ import annotations

from scripts.build_search_index import _document_from_product


def test_document_projection_matches_upstream_search_text() -> None:
    document = _document_from_product(
        {
            "asin": "B000INDEX1",
            "name": "Wireless Headphones",
            "full_description": "Noise Cancelling",
            "small_description": ["Forty Hour Battery", "unused second bullet"],
            "customization_options": {
                "Color": [{"value": " Black ", "image": None}],
                "Size": [{"value": "Small/Medium", "image": None}],
            },
        }
    )

    assert document == {
        "id": "B000INDEX1",
        "contents": (
            "wireless headphones noise cancelling forty hour battery "
            "color: black, and size: small | medium"
        ),
    }


def test_document_projection_applies_upstream_asin_filter() -> None:
    assert (
        _document_from_product(
            {
                "asin": "TOO-LONG-ASIN",
                "name": "ignored",
                "full_description": "ignored",
                "small_description": ["ignored"],
                "customization_options": {},
            }
        )
        is None
    )


def test_document_projection_accepts_upstream_empty_string_options() -> None:
    document = _document_from_product(
        {
            "asin": "B06Y3VLDFB",
            "name": "Console Table",
            "full_description": "Reclaimed wood",
            "small_description": ["Natural finish"],
            "customization_options": "",
        }
    )

    assert document == {
        "id": "B06Y3VLDFB",
        "contents": "console table reclaimed wood natural finish ",
    }
