import ast
import contextlib
import os
import re
import sys
import typing


# According to locale.conf(5) it uses the same format as described in
# os-release(5), so we base the code below on its "Example 5. Reading
# os-release in python(1) (any version)" but fix several issues with
# it (see discussion on tails!2459).
#
# This function is only thread-safe when the GIL is enabled.
def read_locale_conf() -> typing.Generator[tuple[str, str]]:
    filename = "/etc/locale.conf"
    with open(filename) as f:
        for line_number, line in enumerate(f, start=1):
            line = line.rstrip()  # noqa: PLW2901
            if not line or line.startswith("#"):
                continue
            name = None
            val = None
            m = re.match(r"([a-zA-Z_][a-zA-Z_0-9]*)=(.*)", line)
            if m:
                name, val = m.groups()
                if val and val[0] in ['"', "'"]:
                    try:
                        val = ast.literal_eval(val)
                    except ValueError:
                        val = None
            if name is not None and val is not None:
                yield name, val
            else:
                print(f"{filename}:{line_number}: bad line {line!r}", file=sys.stderr)


# Sets environment variables according to /etc/locale.conf
def apply_selected_locale():
    with contextlib.suppress(FileNotFoundError):
        os.environ.update(read_locale_conf())


def lang_to_language_region(lang: str) -> tuple[str, str | None]:
    """
    >>> lang_to_language_region("en_US.UTF-8")
    ('en', 'us')

    >>> lang_to_language_region("es_ES.UTF-8")
    ('es', 'es')

    >>> lang_to_language_region("es_MX.UTF-8")
    ('es', 'mx')

    >>> lang_to_language_region("ll.UTF-8")
    ('ll', None)

    """
    m = re.fullmatch(r"([a-z]+)(?:_([A-Z]+))?[.].*", lang)
    if m:
        language = m.group(1)
        if m.lastindex == 2:
            region = m.group(2).lower()
        else:
            region = None
    else:
        raise RuntimeError("Failed to parse $LANG")

    return (language, region)


def user_language_and_region() -> tuple[str, str | None]:
    """Return the language and region chosen by the user in the Welcome
    Screen, in lowercase, e.g. ("en", "us") or ("es", "mx")"""
    lang = dict(read_locale_conf())["LANG"]
    return lang_to_language_region(lang)


if __name__ == "__main__":
    import doctest

    doctest.testmod()
