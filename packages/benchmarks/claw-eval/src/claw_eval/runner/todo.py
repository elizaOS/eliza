"""In-memory todo list for agent self-planning and progress tracking."""

from __future__ import annotations


class TodoManager:
    """In-memory todo list with status tracking.

    The agent calls the ``todo`` tool with the full list each time.
    At most one item can be ``in_progress`` at any moment.
    """

    def __init__(self) -> None:
        self.items: list[dict] = []

    _VALID_STATUSES = {"pending", "in_progress", "completed"}

    def update(self, items: list[dict]) -> str:
        """Replace the todo list. Returns the rendered todo list string.

        Raises ValueError if:
        - More than one item has status ``in_progress``
        - An item has an invalid status
        """
        in_progress_count = 0
        for item in items:
            status = item.get("status", "pending")
            if status not in self._VALID_STATUSES:
                return f"Error: invalid status '{status}'. Must be one of: {', '.join(sorted(self._VALID_STATUSES))}"
            if status == "in_progress":
                in_progress_count += 1
        if in_progress_count > 1:
            return "Error: at most 1 item can be 'in_progress' at a time."

        self.items = items
        return self.render()

    def render(self) -> str:
        """Render current state as a checklist.

        - ``[ ]`` pending
        - ``[>]`` in_progress
        - ``[x]`` completed
        """
        if not self.items:
            return "(empty todo list)"
        icons = {"pending": "[ ]", "in_progress": "[>]", "completed": "[x]"}
        lines: list[str] = []
        for item in self.items:
            icon = icons.get(item.get("status", "pending"), "[ ]")
            lines.append(f"{icon} #{item.get('id', '?')}: {item.get('content', '')}")
        return "\n".join(lines)
