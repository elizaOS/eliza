from pathlib import Path
import os
import re


class Language:
    NAME = ""
    EXTENSIONS = ()
    SHEBANGS = ()
    SHEBANGS_ONLY_EXECUTABLE = True

    def extract_shebang(self, file: Path) -> str | None:
        with file.open("rb") as buf:
            start = buf.read(2)
            if start != b"#!":
                return None
            return buf.readline().strip().decode("ascii")

    def find_matching(self, needle, haystack) -> bool:
        for hay in haystack:
            if isinstance(hay, str):
                if hay == needle:
                    return True
            elif hay.match(needle) is not None:
                return True
        return False

    def check_extension(self, file: Path) -> bool:
        basename = file.name
        return any(basename.endswith(ext) for ext in self.EXTENSIONS)

    def check_shebang(self, file: Path) -> bool:
        if not self.SHEBANGS:
            return False
        if self.SHEBANGS_ONLY_EXECUTABLE and not os.access(str(file), os.X_OK):
            return False
        shebang = self.extract_shebang(file)
        if shebang is None:
            return False

        return self.find_matching(shebang, self.SHEBANGS)

    def check(self, file: Path) -> bool:
        if file.is_dir():
            return False
        if self.check_extension(file):
            return True
        if self.check_shebang(file):
            return True

        return False

    @classmethod
    def lookup_language(cls, language_name: str) -> "Language":
        for subcls in cls.__subclasses__():
            if language_name == subcls.NAME:
                return subcls
        raise UnsupportedLanguage

    @classmethod
    def list_languages(cls) -> list[str]:
        ret = []
        for subcls in cls.__subclasses__():
            ret.append(subcls.NAME)
        return ret


class UnsupportedLanguage(Exception):
    pass


class Python(Language):
    NAME = "python"
    EXTENSIONS = (".py",)
    SHEBANGS = (re.compile(r".*python3\b"),)


class Shell(Language):
    NAME = "shell"
    EXTENSIONS = (".sh",)
    SHEBANGS = (re.compile(r"/bin/(ba|da|)sh\b"), re.compile(r"/usr/bin/env bash\b"))
    SHEBANGS_ONLY_EXECUTABLE = False  # we have shell scripts which aren't executable


class Ruby(Language):
    NAME = "ruby"
    EXTENSIONS = (".rb",)
    SHEBANGS = (re.compile(r"/usr/bin/(env |)ruby\b"),)
