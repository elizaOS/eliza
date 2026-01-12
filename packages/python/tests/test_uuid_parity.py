import uuid as uuid_module

import pytest

from elizaos.types import string_to_uuid


class TestStringToUuidParity:
    def test_deterministic_vectors_match_typescript(self) -> None:
        vectors = [
            ("test", "a94a8fe5-ccb1-0ba6-9c4c-0873d391e987"),
            ("hello world", "f0355dd5-2823-054c-ae66-a0b12842c215"),
            ("", "da39a3ee-5e6b-0b0d-b255-bfef95601890"),
            ("123", "40bd0015-6308-0fc3-9165-329ea1ff5c5e"),
            ("user:agent", "a49810ce-da30-0d3b-97ee-d4d47774d8af"),
        ]

        for input_str, expected in vectors:
            assert string_to_uuid(input_str) == expected

    def test_returns_existing_uuid_unchanged(self) -> None:
        existing = "550e8400-e29b-41d4-a716-446655440000"
        assert string_to_uuid(existing) == existing

    def test_number_inputs(self) -> None:
        assert string_to_uuid(42) == string_to_uuid("42")
        assert string_to_uuid(0) == string_to_uuid("0")
        assert string_to_uuid(-1) == string_to_uuid("-1")

    def test_invalid_inputs_raise_type_error(self) -> None:
        with pytest.raises(TypeError):
            string_to_uuid(None)  # type: ignore[arg-type]
        with pytest.raises(TypeError):
            string_to_uuid({"x": 1})  # type: ignore[arg-type]

    def test_sets_variant_and_version_bits(self) -> None:
        uuid_str = string_to_uuid("test")
        parts = uuid_str.split("-")
        assert len(parts) == 5

        variant_byte = int(parts[3][0:2], 16)
        assert (variant_byte & 0xC0) == 0x80

        assert parts[2][0] == "0"

        uuid_module.UUID(uuid_str)
