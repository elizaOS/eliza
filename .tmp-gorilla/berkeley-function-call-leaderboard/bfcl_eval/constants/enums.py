from enum import Enum


class ModelStyle(Enum):
    """
    ModelStyle controls how the function doc should be formatted.
    """
    GORILLA = "gorilla"
    OPENAI_COMPLETIONS = "openai-completions"
    OPENAI_RESPONSES = "openai-responses"
    ANTHROPIC = "claude"
    MISTRAL = "mistral"
    GOOGLE = "google"
    AMAZON = "amazon"
    FIREWORK_AI = "firework_ai"
    NEXUS = "nexus"
    OSSMODEL = "ossmodel"
    COHERE = "cohere"
    WRITER = "writer"
    NOVITA_AI = "novita_ai"


class Language(Enum):
    """
    Language controls the type checking for AST checker.
    """
    PYTHON = "python"
    JAVA = "java"
    JAVASCRIPT = "javascript"


class ReturnFormat(Enum):
    """
    ReturnFormat controls the decode_ast logic.
    """
    PYTHON = "python"
    JAVA = "java"
    JAVASCRIPT = "javascript"
    JSON = "json"
    VERBOSE_XML = "verbose_xml"
    CONCISE_XML = "concise_xml"
