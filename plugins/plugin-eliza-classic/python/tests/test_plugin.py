from __future__ import annotations

import json
from pathlib import Path


from elizaos_plugin_eliza_classic import ElizaClassicPlugin, get_greeting, reflect


class TestReflect:
    def test_reflect_i_to_you(self) -> None:
        assert reflect("i am happy") == "you are happy"

    def test_reflect_my_to_your(self) -> None:
        assert reflect("my car") == "your car"

    def test_reflect_you_to_me(self) -> None:
        # doctor.json reflections are script-specific; "you" -> "I"
        assert reflect("you are nice") == "I are nice"

    def test_reflect_preserves_unknown_words(self) -> None:
        assert reflect("the cat sat") == "the cat sat"


class TestGenerateResponse:
    def test_family_response_deterministic(self, plugin: ElizaClassicPlugin) -> None:
        assert (
            plugin.generate_response("my mother is kind")
            == "Tell me more about your family"
        )

    def test_computer_response_cycles(self, plugin: ElizaClassicPlugin) -> None:
        assert plugin.generate_response("computer") == "Do computers worry you?"
        assert plugin.generate_response("computer") == "Why do you mention computers?"

    def test_pre_rule_youre(self, plugin: ElizaClassicPlugin) -> None:
        assert (
            plugin.generate_response("you're sad") == "What makes you think I am sad?"
        )

    def test_memory_recall_on_limit_4(self, plugin: ElizaClassicPlugin) -> None:
        plugin.generate_response("my car is broken")  # records memory
        plugin.generate_response("xyzzy")  # advance LIMIT to 3
        recalled = plugin.generate_response("xyzzy")  # LIMIT 4 -> recall memory
        possible = {
            "Lets discuss further why your car is broken",
            "Earlier you said your car is broken",
            "But your car is broken",
            "Does that have anything to do with the fact that your car is broken?",
        }
        assert recalled in possible

    def test_golden_transcript(self, plugin: ElizaClassicPlugin) -> None:
        transcript = [
            ("hello", "How do you do? Please state your problem"),
            ("computer", "Do computers worry you?"),
            ("computer", "Why do you mention computers?"),
            (
                "computer",
                "What do you think machines have to do with your problem?",
            ),
            ("my mother is kind", "Tell me more about your family"),
            ("xyzzy", "I am not sure I understand you fully"),
        ]
        for user_input, expected in transcript:
            assert plugin.generate_response(user_input) == expected


class TestElizaClassicPlugin:
    def test_generate_response(self, plugin: ElizaClassicPlugin) -> None:
        response = plugin.generate_response("hello")
        assert len(response) > 0

    def test_get_greeting(self, plugin: ElizaClassicPlugin) -> None:
        greeting = plugin.get_greeting()
        assert "problem" in greeting.lower()

    def test_reset_history(self, plugin: ElizaClassicPlugin) -> None:
        plugin.generate_response("hello")
        plugin.reset_history()
        response = plugin.generate_response("hello")
        assert len(response) > 0


class TestGetGreeting:
    def test_greeting_contains_eliza(self) -> None:
        greeting = get_greeting()
        assert "problem" in greeting.lower()

    def test_greeting_is_string(self) -> None:
        greeting = get_greeting()
        assert isinstance(greeting, str)


class TestDoctorJsonValidation:
    def test_doctor_json_redirect_targets_exist(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        doctor_path = repo_root / "shared" / "doctor.json"
        data = json.loads(doctor_path.read_text(encoding="utf-8"))

        keywords = {w.lower() for e in data["keywords"] for w in e["keyword"]}
        redirects: set[str] = set()
        for entry in data["keywords"]:
            for rule in entry["rules"]:
                for r in rule["reassembly"]:
                    if isinstance(r, str) and r.strip().startswith("="):
                        redirects.add(r.strip()[1:].strip().lower())
        missing = sorted([r for r in redirects if r and r not in keywords])
        assert missing == []

    def test_doctor_json_expected_keyword_coverage(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        doctor_path = repo_root / "shared" / "doctor.json"
        data = json.loads(doctor_path.read_text(encoding="utf-8"))
        keywords = {w.lower() for e in data["keywords"] for w in e["keyword"]}

        expected = {
            "sorry",
            "remember",
            "if",
            "dreamt",
            "dreamed",
            "dream",
            "dreams",
            "how",
            "when",
            "what",
            "why",
            "because",
            "my",
            "your",
            "i",
            "you",
            "you're",
            "i'm",
            "dit",
            "like",
            "alike",
            "same",
            "can",
        }
        assert expected.issubset(keywords)
