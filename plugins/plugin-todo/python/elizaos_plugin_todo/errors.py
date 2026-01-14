class TodoError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class ValidationError(TodoError):
    pass


class NotFoundError(TodoError):
    pass


class DatabaseError(TodoError):
    pass


class ConfigError(TodoError):
    pass


class ReminderError(TodoError):
    pass


class NotificationError(TodoError):
    pass
