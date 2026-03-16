"""Tests for elizaos_plugin_webhooks.auth – mirrors TS auth.test.ts."""

from elizaos_plugin_webhooks.auth import extract_token, validate_token


class TestExtractToken:
    def test_extracts_from_bearer_header(self) -> None:
        token = extract_token(
            headers={"authorization": "Bearer my-secret-token"}
        )
        assert token == "my-secret-token"

    def test_extracts_from_x_otto_token_header(self) -> None:
        token = extract_token(headers={"x-otto-token": "my-token"})
        assert token == "my-token"

    def test_extracts_from_query_param(self) -> None:
        token = extract_token(
            headers={}, url="http://localhost/hooks/wake?token=query-tok"
        )
        assert token == "query-tok"

    def test_prefers_authorization_over_x_otto_token(self) -> None:
        token = extract_token(
            headers={
                "authorization": "Bearer bearer-tok",
                "x-otto-token": "header-tok",
            }
        )
        assert token == "bearer-tok"

    def test_returns_none_when_no_token_present(self) -> None:
        token = extract_token(headers={})
        assert token is None

    def test_handles_missing_headers(self) -> None:
        token = extract_token()
        assert token is None

    def test_extracts_from_query_dict(self) -> None:
        token = extract_token(headers={}, query={"token": "dict-tok"})
        assert token == "dict-tok"

    def test_extracts_from_query_dict_list(self) -> None:
        token = extract_token(headers={}, query={"token": ["list-tok"]})
        assert token == "list-tok"

    def test_handles_capitalised_authorization(self) -> None:
        token = extract_token(
            headers={"Authorization": "Bearer cap-token"}
        )
        assert token == "cap-token"

    def test_handles_capitalised_x_otto_token(self) -> None:
        token = extract_token(headers={"X-Otto-Token": "cap-otto"})
        assert token == "cap-otto"

    def test_handles_array_authorization_header(self) -> None:
        token = extract_token(
            headers={"authorization": ["Bearer arr-tok", "Bearer second"]}
        )
        assert token == "arr-tok"

    def test_handles_array_x_otto_token_header(self) -> None:
        token = extract_token(
            headers={"x-otto-token": ["arr-otto", "second"]}
        )
        assert token == "arr-otto"

    def test_trims_whitespace(self) -> None:
        token = extract_token(
            headers={"authorization": "Bearer   padded-token  "}
        )
        assert token == "padded-token"


class TestValidateToken:
    def test_returns_true_for_matching_token(self) -> None:
        result = validate_token(
            "correct-token",
            headers={"authorization": "Bearer correct-token"},
        )
        assert result is True

    def test_returns_false_for_wrong_token(self) -> None:
        result = validate_token(
            "correct-token",
            headers={"authorization": "Bearer wrong-token"},
        )
        assert result is False

    def test_returns_false_for_missing_token(self) -> None:
        result = validate_token("any-token", headers={})
        assert result is False

    def test_returns_false_for_different_length_token(self) -> None:
        result = validate_token(
            "much-longer-expected-token",
            headers={"authorization": "Bearer short"},
        )
        assert result is False
