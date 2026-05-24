def shell_value_to_bool(value: str) -> bool:
    """
    Convert a string to a boolean, using shell typical conventions.

    >>> shell_value_to_bool("true")
    True
    >>> shell_value_to_bool("false")
    False
    >>> shell_value_to_bool("1")
    True
    >>> shell_value_to_bool("0")
    False
    """
    value = value.strip()
    if value == "false":
        return False
    if value == "true":
        return True
    try:
        i = int(value)
        return bool(i)
    except ValueError:
        pass
    raise ValueError("the value doesn't seem to be a boolean")
