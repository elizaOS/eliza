"""Tests for command parser and text encoder."""

import numpy as np

from eliza_robot.rl.meta.command_parser import CommandParser, parse_command_regex
from eliza_robot.rl.meta.text_encoder import EMBEDDING_DIM, BagOfWordsEncoder, TextEncoder


class TestBagOfWordsEncoder:
    def test_output_shape(self):
        enc = BagOfWordsEncoder(dim=384)
        result = enc.encode(["hello world"])
        assert result.shape == (1, 384)

    def test_batch_encode(self):
        enc = BagOfWordsEncoder(dim=384)
        result = enc.encode(["hello", "world", "test"])
        assert result.shape == (3, 384)

    def test_normalized(self):
        enc = BagOfWordsEncoder(dim=384)
        result = enc.encode(["walk forward slowly"])
        norm = np.linalg.norm(result[0])
        assert abs(norm - 1.0) < 0.01

    def test_deterministic(self):
        enc = BagOfWordsEncoder(dim=384)
        r1 = enc.encode(["walk forward"])
        r2 = enc.encode(["walk forward"])
        assert np.allclose(r1, r2)


class TestTextEncoder:
    def test_fallback_to_bow(self):
        enc = TextEncoder(prefer_transformer=False)
        assert not enc.uses_transformer
        assert enc.dim == EMBEDDING_DIM

    def test_encode_single(self):
        enc = TextEncoder(prefer_transformer=False)
        result = enc.encode_single("hello")
        assert result.shape == (EMBEDDING_DIM,)


class TestRegexParser:
    def test_walk_forward(self):
        result = parse_command_regex("walk forward")
        assert result is not None
        assert result.skill_name == "walk"
        assert result.confidence == 1.0

    def test_walk_slowly(self):
        result = parse_command_regex("walk slowly")
        assert result is not None
        assert result.skill_name == "walk"
        assert result.params.speed == 0.25

    def test_turn_left(self):
        result = parse_command_regex("turn left")
        assert result is not None
        assert result.skill_name == "turn"
        assert result.params.direction == -1.0

    def test_turn_right(self):
        result = parse_command_regex("turn right")
        assert result is not None
        assert result.skill_name == "turn"
        assert result.params.direction == 1.0

    def test_stop(self):
        result = parse_command_regex("stop")
        assert result is not None
        assert result.skill_name == "stand"

    def test_wave(self):
        result = parse_command_regex("wave")
        assert result is not None
        assert result.skill_name == "wave"

    def test_bow(self):
        result = parse_command_regex("bow")
        assert result is not None
        assert result.skill_name == "bow"

    def test_say_hello(self):
        result = parse_command_regex("say hello")
        assert result is not None
        assert result.skill_name == "wave"

    def test_no_match(self):
        result = parse_command_regex("do a backflip")
        assert result is None

    def test_case_insensitive(self):
        result = parse_command_regex("Walk Forward")
        assert result is not None
        assert result.skill_name == "walk"


class TestCommandParser:
    def test_regex_fast_path(self):
        parser = CommandParser()
        result = parser.parse("walk forward")
        assert result.skill_name == "walk"
        assert result.confidence == 1.0

    def test_embedding_fallback(self):
        parser = CommandParser()
        result = parser.parse("please locomote in a forward direction")
        assert result is not None
        assert isinstance(result.skill_name, str)
        assert result.confidence >= 0.0

    def test_stop_command(self):
        parser = CommandParser()
        result = parser.parse("stop moving")
        assert result.skill_name == "stand"
