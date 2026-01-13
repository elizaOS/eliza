import pytest

from elizaos_plugin_shell.path_utils import (
    extract_base_command,
    is_forbidden_command,
    is_safe_command,
    validate_path,
)


class TestValidatePath:
    def test_allows_paths_within_allowed_directory(self) -> None:
        result = validate_path(
            "subfolder",
            "/home/user/allowed",
            "/home/user/allowed",
        )
        assert result == "/home/user/allowed/subfolder"

    def test_rejects_paths_outside_allowed_directory(self) -> None:
        result = validate_path(
            "../../../etc",
            "/home/user/allowed",
            "/home/user/allowed",
        )
        assert result is None

    def test_handles_absolute_paths_correctly(self) -> None:
        result = validate_path(
            "/home/user/allowed/sub",
            "/home/user/allowed",
            "/home/user/allowed",
        )
        assert result == "/home/user/allowed/sub"


class TestIsSafeCommand:
    def test_allows_safe_commands(self) -> None:
        assert is_safe_command("ls -la") is True
        assert is_safe_command("echo hello") is True
        assert is_safe_command("pwd") is True
        assert is_safe_command('echo "Hello World" > file.txt') is True
        assert is_safe_command("cat < input.txt") is True
        assert is_safe_command("touch newfile.txt") is True
        assert is_safe_command("mkdir newdir") is True

    def test_rejects_path_traversal(self) -> None:
        assert is_safe_command("cd ../..") is False
        assert is_safe_command("ls ../../../etc") is False

    def test_rejects_dangerous_patterns(self) -> None:
        assert is_safe_command("rm -rf / | sudo rm -rf /") is False
        assert is_safe_command("echo $(malicious)") is False
        assert is_safe_command("ls | grep test | wc -l") is False
        assert is_safe_command("cmd1 && cmd2") is False
        assert is_safe_command("cmd1 || cmd2") is False


class TestExtractBaseCommand:
    def test_extracts_base_command_correctly(self) -> None:
        assert extract_base_command("ls -la") == "ls"
        assert extract_base_command("git status") == "git"
        assert extract_base_command("  npm   test  ") == "npm"

    def test_handles_empty_commands(self) -> None:
        assert extract_base_command("") == ""
        assert extract_base_command("   ") == ""


class TestIsForbiddenCommand:
    @pytest.fixture
    def forbidden(self) -> list[str]:
        return ["rm -rf /", "sudo rm -rf", "chmod 777", "shutdown"]

    def test_detects_forbidden_patterns(self, forbidden: list[str]) -> None:
        assert is_forbidden_command("rm -rf /", forbidden) is True
        assert is_forbidden_command("sudo rm -rf /home", forbidden) is True
        assert is_forbidden_command("chmod 777 /etc", forbidden) is True
        assert is_forbidden_command("shutdown now", forbidden) is True

    def test_allows_safe_variations(self, forbidden: list[str]) -> None:
        assert is_forbidden_command("rm file.txt", forbidden) is False
        assert is_forbidden_command("chmod 644 file", forbidden) is False
        assert is_forbidden_command("sudo apt update", forbidden) is False

    def test_allows_non_forbidden_commands(self, forbidden: list[str]) -> None:
        assert is_forbidden_command("ls -la", forbidden) is False
        assert is_forbidden_command("echo hello", forbidden) is False
        assert is_forbidden_command("brew install package", forbidden) is False

    def test_case_insensitive(self, forbidden: list[str]) -> None:
        assert is_forbidden_command("RM -RF /", forbidden) is True
        assert is_forbidden_command("SHUTDOWN", forbidden) is True
