import logging
import threading


class CustomAdapter(logging.LoggerAdapter):
    def process(self, msg, kwargs):
        t = threading.current_thread()
        if t.name == "MainThread":
            _id = "0"
        else:
            _id = f"{t.native_id}-{t.name.removeprefix('Thread-')}"
        return f"[{_id}] {msg}", kwargs


def get_logger(name: str) -> logging.LoggerAdapter:
    return CustomAdapter(logging.getLogger(name), None)
