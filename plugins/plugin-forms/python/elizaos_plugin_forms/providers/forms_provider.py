from dataclasses import dataclass, field
from typing import Any, ClassVar

from elizaos_plugin_forms.types import Form, FormStatus


@dataclass
class ProviderResult:
    text: str = ""
    values: dict[str, Any] = field(default_factory=dict)
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class FormsContextProvider:
    name: ClassVar[str] = "FORMS_CONTEXT"
    description: ClassVar[str] = "Provides context about active forms and their current state"
    dynamic: ClassVar[bool] = True  # Only called when needed
    position: ClassVar[int] = 50  # Mid-priority

    @staticmethod
    def generate_context(forms: list[Form]) -> ProviderResult:
        if not forms:
            return ProviderResult()

        context_text = "[FORMS]\n"
        serialized_forms: list[dict[str, Any]] = []

        for form in forms:
            current_step = form.steps[form.current_step_index]
            context_text += f"\nActive Form: {form.name} (ID: {form.id})\n"
            context_text += f"Current Step: {current_step.name or current_step.id}\n"

            completed_fields = [f for f in current_step.fields if f.value is not None]
            if completed_fields:
                context_text += "Completed fields:\n"
                for fld in completed_fields:
                    display_value = "[SECRET]" if fld.secret else str(fld.value)
                    context_text += f"  - {fld.label}: {display_value}\n"

            remaining_required = [
                f for f in current_step.fields if not f.optional and f.value is None
            ]
            if remaining_required:
                context_text += "Required fields:\n"
                for fld in remaining_required:
                    desc = f" ({fld.description})" if fld.description else ""
                    context_text += f"  - {fld.label}{desc}\n"

            optional_fields = [f for f in current_step.fields if f.optional and f.value is None]
            if optional_fields:
                context_text += "Optional fields:\n"
                for fld in optional_fields:
                    desc = f" ({fld.description})" if fld.description else ""
                    context_text += f"  - {fld.label}{desc}\n"

            context_text += f"Progress: Step {form.current_step_index + 1} of {len(form.steps)}\n"

            serialized_forms.append(
                {
                    "id": str(form.id),
                    "name": form.name,
                    "description": form.description,
                    "status": (
                        form.status.value if isinstance(form.status, FormStatus) else form.status
                    ),
                    "currentStepIndex": form.current_step_index,
                    "stepsCount": len(form.steps),
                    "createdAt": form.created_at.isoformat() if form.created_at else None,
                    "updatedAt": form.updated_at.isoformat() if form.updated_at else None,
                }
            )

        return ProviderResult(
            text=context_text,
            values={"activeFormsCount": len(forms)},
            data={"forms": serialized_forms},
        )
