"""Tests for forms plugin actions."""

from elizaos_plugin_forms import (
    CancelFormAction,
    CreateFormAction,
    UpdateFormAction,
)


class TestCreateFormAction:
    """Tests for CreateFormAction."""

    def test_action_name(self) -> None:
        """Test action name."""
        assert CreateFormAction.name == "CREATE_FORM"

    def test_action_similes(self) -> None:
        """Test action similes."""
        assert "START_FORM" in CreateFormAction.similes
        assert "NEW_FORM" in CreateFormAction.similes

    def test_extract_form_type_contact(self) -> None:
        """Test extracting contact form type."""
        assert CreateFormAction.extract_form_type("I need a contact form") == "contact"
        assert CreateFormAction.extract_form_type("reach out to you") == "contact"

    def test_extract_form_type_feedback(self) -> None:
        """Test extracting feedback form type."""
        assert CreateFormAction.extract_form_type("give feedback") == "feedback"
        assert CreateFormAction.extract_form_type("leave a review") == "feedback"

    def test_extract_form_type_application(self) -> None:
        """Test extracting application form type."""
        assert CreateFormAction.extract_form_type("apply for job") == "application"
        assert CreateFormAction.extract_form_type("job application") == "application"

    def test_extract_form_type_survey(self) -> None:
        """Test extracting survey form type."""
        assert CreateFormAction.extract_form_type("take a survey") == "survey"
        assert CreateFormAction.extract_form_type("questionnaire") == "survey"

    def test_extract_form_type_registration(self) -> None:
        """Test extracting registration form type."""
        assert CreateFormAction.extract_form_type("sign up") == "registration"
        assert CreateFormAction.extract_form_type("register now") == "registration"

    def test_extract_form_type_none(self) -> None:
        """Test when no form type matches."""
        assert CreateFormAction.extract_form_type("hello world") is None
        assert CreateFormAction.extract_form_type("random text") is None

    def test_validate_with_form_keywords(self) -> None:
        """Test validation with form keywords."""
        assert CreateFormAction.validate("I need to fill out a form", False, True)
        assert CreateFormAction.validate("help with questionnaire", False, True)
        assert CreateFormAction.validate("contact us", False, True)

    def test_validate_without_service(self) -> None:
        """Test validation without forms service."""
        assert not CreateFormAction.validate("I need a form", False, False)

    def test_validate_without_keywords(self) -> None:
        """Test validation without form keywords."""
        assert not CreateFormAction.validate("hello there", False, True)

    def test_examples(self) -> None:
        """Test action examples."""
        examples = CreateFormAction.examples()
        assert len(examples) >= 2
        assert examples[0].role == "user"
        assert examples[1].role == "assistant"
        assert "CREATE_FORM" in examples[1].actions


class TestUpdateFormAction:
    """Tests for UpdateFormAction."""

    def test_action_name(self) -> None:
        """Test action name."""
        assert UpdateFormAction.name == "UPDATE_FORM"

    def test_action_similes(self) -> None:
        """Test action similes."""
        assert "FILL_FORM" in UpdateFormAction.similes
        assert "SUBMIT_FORM" in UpdateFormAction.similes

    def test_contains_form_input_name(self) -> None:
        """Test detecting name input."""
        assert UpdateFormAction.contains_form_input("My name is John")
        assert UpdateFormAction.contains_form_input("I am John Smith")

    def test_contains_form_input_email(self) -> None:
        """Test detecting email input."""
        assert UpdateFormAction.contains_form_input("test@example.com")
        assert UpdateFormAction.contains_form_input("email: john@test.org")

    def test_contains_form_input_numbers(self) -> None:
        """Test detecting number input."""
        assert UpdateFormAction.contains_form_input("my phone is 1234567890")
        assert UpdateFormAction.contains_form_input("I am 25 years old")

    def test_contains_form_input_long_text(self) -> None:
        """Test detecting longer text input."""
        assert UpdateFormAction.contains_form_input("This is a longer message")

    def test_contains_form_input_short(self) -> None:
        """Test rejecting short messages."""
        assert not UpdateFormAction.contains_form_input("Hi")
        assert not UpdateFormAction.contains_form_input("OK")

    def test_validate_with_active_forms(self) -> None:
        """Test validation with active forms."""
        assert UpdateFormAction.validate("My name is John", True, True)

    def test_validate_without_active_forms(self) -> None:
        """Test validation without active forms."""
        assert not UpdateFormAction.validate("My name is John", False, True)

    def test_validate_without_service(self) -> None:
        """Test validation without forms service."""
        assert not UpdateFormAction.validate("My name is John", True, False)

    def test_examples(self) -> None:
        """Test action examples."""
        examples = UpdateFormAction.examples()
        assert len(examples) >= 2
        has_update = any("UPDATE_FORM" in e.actions for e in examples)
        assert has_update


class TestCancelFormAction:
    """Tests for CancelFormAction."""

    def test_action_name(self) -> None:
        """Test action name."""
        assert CancelFormAction.name == "CANCEL_FORM"

    def test_action_similes(self) -> None:
        """Test action similes."""
        assert "ABORT_FORM" in CancelFormAction.similes
        assert "STOP_FORM" in CancelFormAction.similes
        assert "QUIT_FORM" in CancelFormAction.similes

    def test_wants_cancel_keywords(self) -> None:
        """Test detecting cancel keywords."""
        assert CancelFormAction.wants_cancel("cancel the form")
        assert CancelFormAction.wants_cancel("stop please")
        assert CancelFormAction.wants_cancel("abort this")
        assert CancelFormAction.wants_cancel("quit")
        assert CancelFormAction.wants_cancel("exit now")
        assert CancelFormAction.wants_cancel("nevermind")
        assert CancelFormAction.wants_cancel("never mind")
        assert CancelFormAction.wants_cancel("I don't want to do this")

    def test_wants_cancel_no_keywords(self) -> None:
        """Test when no cancel keywords present."""
        assert not CancelFormAction.wants_cancel("continue please")
        assert not CancelFormAction.wants_cancel("My name is John")
        assert not CancelFormAction.wants_cancel("submit the form")

    def test_validate_with_active_forms(self) -> None:
        """Test validation with active forms and cancel intent."""
        assert CancelFormAction.validate("cancel the form", True, True)

    def test_validate_without_active_forms(self) -> None:
        """Test validation without active forms."""
        assert not CancelFormAction.validate("cancel", False, True)

    def test_validate_without_cancel_intent(self) -> None:
        """Test validation without cancel intent."""
        assert not CancelFormAction.validate("continue", True, True)

    def test_validate_without_service(self) -> None:
        """Test validation without forms service."""
        assert not CancelFormAction.validate("cancel", True, False)

    def test_examples(self) -> None:
        """Test action examples."""
        examples = CancelFormAction.examples()
        assert len(examples) >= 2
        has_cancel = any("CANCEL_FORM" in e.actions for e in examples)
        assert has_cancel
