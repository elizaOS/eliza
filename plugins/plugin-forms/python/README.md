# elizaOS Forms Plugin (Python)

Python implementation of the elizaOS Forms Plugin for structured conversational data collection.

## Installation

```bash
pip install elizaos-plugin-forms
```

## Usage

```python
from elizaos_plugin_forms import FormsService, FormTemplate, FormStep, FormField, FormFieldType

# Initialize the service with a runtime
service = FormsService(runtime)

# Create a form from template
form = await service.create_form("contact")

# Or create a custom form
custom_form = await service.create_form(
    FormTemplate(
        name="survey",
        description="Customer satisfaction survey",
        steps=[
            FormStep(
                id="rating",
                name="Rating",
                fields=[
                    FormField(
                        id="satisfaction",
                        label="Overall Satisfaction",
                        type=FormFieldType.NUMBER,
                        description="Rate from 1-10",
                        criteria="Must be between 1 and 10",
                    ),
                ],
            ),
        ],
    )
)

# Update form with user message
result = await service.update_form(form.id, "My name is John and email is john@example.com")

# Check if form is complete
if result.form_completed:
    print("Form completed!")
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_forms

# Linting
ruff check .
ruff format .
```

## License

MIT


