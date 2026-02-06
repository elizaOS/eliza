"""Tests for scratchpad action specs and metadata."""

from elizaos_plugin_scratchpad.actions import (
    SCRATCHPAD_APPEND_ACTION,
    SCRATCHPAD_DELETE_ACTION,
    SCRATCHPAD_LIST_ACTION,
    SCRATCHPAD_READ_ACTION,
    SCRATCHPAD_SEARCH_ACTION,
    SCRATCHPAD_WRITE_ACTION,
)


def test_write_action_spec():
    """Test SCRATCHPAD_WRITE action spec has required fields."""
    assert SCRATCHPAD_WRITE_ACTION["name"] == "SCRATCHPAD_WRITE"
    assert isinstance(SCRATCHPAD_WRITE_ACTION["description"], str)
    assert len(str(SCRATCHPAD_WRITE_ACTION["description"])) > 0
    similes = SCRATCHPAD_WRITE_ACTION["similes"]
    assert isinstance(similes, list)
    assert "SAVE_NOTE" in similes
    assert "WRITE_NOTE" in similes
    examples = SCRATCHPAD_WRITE_ACTION.get("examples")
    assert isinstance(examples, list)
    assert len(examples) > 0


def test_read_action_spec():
    """Test SCRATCHPAD_READ action spec has required fields."""
    assert SCRATCHPAD_READ_ACTION["name"] == "SCRATCHPAD_READ"
    assert isinstance(SCRATCHPAD_READ_ACTION["description"], str)
    similes = SCRATCHPAD_READ_ACTION["similes"]
    assert isinstance(similes, list)
    assert "READ_NOTE" in similes


def test_search_action_spec():
    """Test SCRATCHPAD_SEARCH action spec has required fields."""
    assert SCRATCHPAD_SEARCH_ACTION["name"] == "SCRATCHPAD_SEARCH"
    assert isinstance(SCRATCHPAD_SEARCH_ACTION["description"], str)
    similes = SCRATCHPAD_SEARCH_ACTION["similes"]
    assert isinstance(similes, list)
    assert "SEARCH_NOTES" in similes


def test_list_action_spec():
    """Test SCRATCHPAD_LIST action spec has required fields."""
    assert SCRATCHPAD_LIST_ACTION["name"] == "SCRATCHPAD_LIST"
    assert isinstance(SCRATCHPAD_LIST_ACTION["description"], str)
    similes = SCRATCHPAD_LIST_ACTION["similes"]
    assert isinstance(similes, list)
    assert "LIST_NOTES" in similes


def test_delete_action_spec():
    """Test SCRATCHPAD_DELETE action spec has required fields."""
    assert SCRATCHPAD_DELETE_ACTION["name"] == "SCRATCHPAD_DELETE"
    assert isinstance(SCRATCHPAD_DELETE_ACTION["description"], str)
    similes = SCRATCHPAD_DELETE_ACTION["similes"]
    assert isinstance(similes, list)
    assert "DELETE_NOTE" in similes


def test_append_action_spec():
    """Test SCRATCHPAD_APPEND action spec has required fields."""
    assert SCRATCHPAD_APPEND_ACTION["name"] == "SCRATCHPAD_APPEND"
    assert isinstance(SCRATCHPAD_APPEND_ACTION["description"], str)
    similes = SCRATCHPAD_APPEND_ACTION["similes"]
    assert isinstance(similes, list)
    assert "ADD_TO_NOTE" in similes


def test_all_actions_have_unique_names():
    """Test that all action names are unique."""
    names = [
        SCRATCHPAD_WRITE_ACTION["name"],
        SCRATCHPAD_READ_ACTION["name"],
        SCRATCHPAD_SEARCH_ACTION["name"],
        SCRATCHPAD_LIST_ACTION["name"],
        SCRATCHPAD_DELETE_ACTION["name"],
        SCRATCHPAD_APPEND_ACTION["name"],
    ]
    assert len(names) == len(set(names))
